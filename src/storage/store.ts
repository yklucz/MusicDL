import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, Track, LibraryTrack, LocalPlaylist, AudioFormat } from '../core/types.js';

type Row = Record<string, string | number | null>;
export interface HistoryEntry {
  id: number;
  jobId: string;
  title: string;
  status: string;
  message: string;
  createdAt: number;
}
export interface DownloadPlaylist {
  id: string;
  name: string;
  tracks: Track[];
  playlistId: string;
  outputPath: string;
  status: string;
  format: AudioFormat;
  error?: string | undefined;
}
export class Store {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:' && process.platform !== 'win32') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, track_key TEXT NOT NULL, track_json TEXT NOT NULL, format TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, output_path TEXT, file_hash TEXT, batch_id TEXT, progress_json TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_unique ON jobs(track_key,format) WHERE status IN ('queued','downloading','processing','retrying');
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_isrc ON jobs(UPPER(json_extract(track_json,'$.isrc')),format) WHERE json_extract(track_json,'$.isrc') IS NOT NULL AND json_extract(track_json,'$.isrc')<>'' AND status IN ('queued','downloading','processing','retrying');
      CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL, duration REAL NOT NULL, codec TEXT NOT NULL, bitrate REAL NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, source_key TEXT, isrc TEXT, hash TEXT);
      CREATE INDEX IF NOT EXISTS tracks_source ON tracks(source_key); CREATE INDEX IF NOT EXISTS tracks_isrc ON tracks(isrc); CREATE INDEX IF NOT EXISTS tracks_hash ON tracks(hash);
      CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS playlist_tracks (playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY(playlist_id,track_id), UNIQUE(playlist_id,position));
      CREATE TABLE IF NOT EXISTS download_playlists (id TEXT PRIMARY KEY,name TEXT NOT NULL,tracks_json TEXT NOT NULL,playlist_id TEXT NOT NULL,output_path TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
      PRAGMA user_version=1;`);
    const columns = this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'audio_info_json'))
      this.db.exec('ALTER TABLE jobs ADD COLUMN audio_info_json TEXT');
    this.db.exec('PRAGMA user_version=2');
    const batchColumns = this.db.prepare('PRAGMA table_info(download_playlists)').all() as {
      name: string;
    }[];
    if (!batchColumns.some((column) => column.name === 'format'))
      this.db.exec("ALTER TABLE download_playlists ADD COLUMN format TEXT NOT NULL DEFAULT 'mp3'");
    this.db.exec('PRAGMA user_version=3');
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  addJob(job: Job): void {
    this.db
      .prepare(
        'INSERT INTO jobs(id,track_key,track_json,format,status,attempts,created_at,updated_at,next_attempt_at,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        job.id,
        job.track.key,
        JSON.stringify(job.track),
        job.format,
        job.status,
        job.attempts,
        job.createdAt,
        job.updatedAt,
        job.nextAttemptAt,
        job.batchId ?? null,
      );
  }
  job(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
    return row ? this.toJob(row) : undefined;
  }
  jobs(): Job[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at,id').all() as Row[]).map(
      (row) => this.toJob(row),
    );
  }
  updateJob(
    id: string,
    patch: Partial<
      Pick<
        Job,
        | 'status'
        | 'attempts'
        | 'nextAttemptAt'
        | 'error'
        | 'outputPath'
        | 'fileHash'
        | 'progress'
        | 'track'
        | 'audioInfo'
      >
    >,
  ): void {
    const mapping: Record<string, string> = {
      status: 'status',
      attempts: 'attempts',
      nextAttemptAt: 'next_attempt_at',
      error: 'error',
      outputPath: 'output_path',
      fileHash: 'file_hash',
      progress: 'progress_json',
      track: 'track_json',
      audioInfo: 'audio_info_json',
    };
    const entries = Object.entries(patch).filter(([key]) => mapping[key]);
    if (!entries.length) return;
    const values = entries.map(([key, value]) =>
      value === undefined
        ? null
        : ['progress', 'track', 'audioInfo'].includes(key)
          ? JSON.stringify(value)
          : (value as string | number),
    );
    this.db
      .prepare(
        `UPDATE jobs SET ${entries.map(([key]) => `${mapping[key]}=?`).join(',')},updated_at=? WHERE id=?`,
      )
      .run(...values, Date.now(), id);
  }
  activeDuplicate(track: Track, format: string): Job | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM jobs WHERE (track_key=? OR (? IS NOT NULL AND UPPER(json_extract(track_json,'$.isrc'))=UPPER(?))) AND format=? AND status IN ('queued','downloading','processing','retrying')",
      )
      .get(track.key, track.isrc ?? null, track.isrc ?? null, format) as Row | undefined;
    return row ? this.toJob(row) : undefined;
  }
  addHistory(job: Job, status: string, message = ''): void {
    this.db
      .prepare('INSERT INTO history(job_id,title,status,message,created_at) VALUES(?,?,?,?,?)')
      .run(job.id, job.track.title, status, message, Date.now());
  }
  history(limit = 100): HistoryEntry[] {
    return (
      this.db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT ?').all(limit) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      jobId: String(r.job_id),
      title: String(r.title),
      status: String(r.status),
      message: String(r.message),
      createdAt: Number(r.created_at),
    }));
  }
  upsertTrack(track: LibraryTrack): LibraryTrack {
    const existing = this.trackByPath(track.path);
    const id = existing?.id ?? track.id;
    this.db
      .prepare(
        `INSERT INTO tracks(id,path,title,artist,album,duration,codec,bitrate,size,mtime,source_key,isrc,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET title=excluded.title,artist=excluded.artist,album=excluded.album,duration=excluded.duration,codec=excluded.codec,bitrate=excluded.bitrate,size=excluded.size,mtime=excluded.mtime,source_key=COALESCE(excluded.source_key,tracks.source_key),isrc=COALESCE(excluded.isrc,tracks.isrc),hash=excluded.hash`,
      )
      .run(
        id,
        track.path,
        track.title,
        track.artist,
        track.album,
        track.duration,
        track.codec,
        track.bitrate,
        track.size,
        track.mtime,
        track.sourceKey ?? null,
        track.isrc ?? null,
        track.hash ?? null,
      );
    return { ...track, id };
  }
  track(id: string): LibraryTrack | undefined {
    const row = this.db.prepare('SELECT * FROM tracks WHERE id=?').get(id) as Row | undefined;
    return row ? this.toTrack(row) : undefined;
  }
  trackByPath(file: string): LibraryTrack | undefined {
    const row = this.db.prepare('SELECT * FROM tracks WHERE path=?').get(file) as Row | undefined;
    return row ? this.toTrack(row) : undefined;
  }
  library(query = ''): LibraryTrack[] {
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    return (
      this.db
        .prepare(
          "SELECT * FROM tracks WHERE title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\' ORDER BY artist,album,title",
        )
        .all(pattern, pattern, pattern) as Row[]
    ).map((row) => this.toTrack(row));
  }
  duplicatesFor(track: Track): LibraryTrack[] {
    return (
      this.db
        .prepare('SELECT * FROM tracks WHERE source_key=? OR (? IS NOT NULL AND isrc=?)')
        .all(track.key, track.isrc ?? null, track.isrc ?? null) as Row[]
    ).map((row) => this.toTrack(row));
  }
  duplicateGroups(): LibraryTrack[][] {
    const rows = this.db
      .prepare('SELECT hash FROM tracks WHERE hash IS NOT NULL GROUP BY hash HAVING COUNT(*)>1')
      .all() as Row[];
    return rows.map((r) =>
      (
        this.db.prepare('SELECT * FROM tracks WHERE hash=? ORDER BY path').all(r.hash!) as Row[]
      ).map((row) => this.toTrack(row)),
    );
  }
  updateTrackPath(id: string, file: string): void {
    this.db.prepare('UPDATE tracks SET path=? WHERE id=?').run(file, id);
  }
  removeTrack(id: string): void {
    this.db.prepare('DELETE FROM tracks WHERE id=?').run(id);
  }
  createPlaylist(name: string): LocalPlaylist {
    const playlist = { id: randomUUID(), name, createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO playlists VALUES(?,?,?)')
      .run(playlist.id, name, playlist.createdAt);
    return playlist;
  }
  playlists(): LocalPlaylist[] {
    return (this.db.prepare('SELECT * FROM playlists ORDER BY created_at,id').all() as Row[]).map(
      (r) => ({ id: String(r.id), name: String(r.name), createdAt: Number(r.created_at) }),
    );
  }
  renamePlaylist(id: string, name: string): void {
    this.db.prepare('UPDATE playlists SET name=? WHERE id=?').run(name, id);
  }
  deletePlaylist(id: string): void {
    this.db.prepare('DELETE FROM playlists WHERE id=?').run(id);
  }
  playlistTracks(id: string): LibraryTrack[] {
    return (
      this.db
        .prepare(
          'SELECT t.* FROM playlist_tracks p JOIN tracks t ON p.track_id=t.id WHERE p.playlist_id=? ORDER BY p.position',
        )
        .all(id) as Row[]
    ).map((r) => this.toTrack(r));
  }
  setPlaylistTracks(id: string, trackIds: string[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=?').run(id);
      const statement = this.db.prepare('INSERT INTO playlist_tracks VALUES(?,?,?)');
      [...new Set(trackIds)].forEach((trackId, position) => statement.run(id, trackId, position));
    });
  }
  createDownloadPlaylist(
    name: string,
    tracks: Track[],
    outputPath: string,
    format: AudioFormat = 'mp3',
  ): DownloadPlaylist {
    return this.transaction(() => {
      const playlist = this.createPlaylist(name);
      const batch: DownloadPlaylist = {
        id: randomUUID(),
        name,
        tracks,
        playlistId: playlist.id,
        outputPath,
        status: 'pending',
        format,
      };
      this.db
        .prepare(
          'INSERT INTO download_playlists(id,name,tracks_json,playlist_id,output_path,status,error,format) VALUES(?,?,?,?,?,?,NULL,?)',
        )
        .run(batch.id, name, JSON.stringify(tracks), playlist.id, outputPath, 'pending', format);
      return batch;
    });
  }
  downloadPlaylists(): DownloadPlaylist[] {
    return (this.db.prepare('SELECT * FROM download_playlists').all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      tracks: JSON.parse(String(r.tracks_json)) as Track[],
      playlistId: String(r.playlist_id),
      outputPath: String(r.output_path),
      status: String(r.status),
      format: r.format as AudioFormat,
      error: r.error ? String(r.error) : undefined,
    }));
  }
  finishDownloadPlaylist(id: string, status: string, error?: string): void {
    this.db
      .prepare('UPDATE download_playlists SET status=?,error=? WHERE id=?')
      .run(status, error ?? null, id);
  }
  private toJob(r: Row): Job {
    return {
      id: String(r.id),
      track: JSON.parse(String(r.track_json)) as Track,
      format: r.format as Job['format'],
      status: r.status as Job['status'],
      attempts: Number(r.attempts),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      nextAttemptAt: Number(r.next_attempt_at),
      error: r.error ? String(r.error) : undefined,
      outputPath: r.output_path ? String(r.output_path) : undefined,
      fileHash: r.file_hash ? String(r.file_hash) : undefined,
      batchId: r.batch_id ? String(r.batch_id) : undefined,
      progress: r.progress_json
        ? (JSON.parse(String(r.progress_json)) as Job['progress'])
        : undefined,
      audioInfo: r.audio_info_json
        ? (JSON.parse(String(r.audio_info_json)) as Job['audioInfo'])
        : undefined,
    };
  }
  private toTrack(r: Row): LibraryTrack {
    return {
      id: String(r.id),
      path: String(r.path),
      title: String(r.title),
      artist: String(r.artist),
      album: String(r.album),
      duration: Number(r.duration),
      codec: String(r.codec),
      bitrate: Number(r.bitrate),
      size: Number(r.size),
      mtime: Number(r.mtime),
      sourceKey: r.source_key ? String(r.source_key) : undefined,
      isrc: r.isrc ? String(r.isrc) : undefined,
      hash: r.hash ? String(r.hash) : undefined,
    };
  }
}
