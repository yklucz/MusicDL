import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  readdir,
  realpath,
  stat,
  mkdir,
  mkdtemp,
  rm,
  rename,
  copyFile,
  constants,
} from 'node:fs/promises';
import type { AudioFormat, LibraryTrack, PlanEntry, Track } from './core/types.js';
import { MusicDLError } from './core/errors.js';
import {
  cleanText,
  ensureSafeParent,
  exists,
  expandPath,
  publishExclusive,
  safeSegment,
} from './core/safety.js';
import { hashFile } from './core/files.js';
import { Store } from './storage/store.js';
import type { AudioProcessor } from './audio/processor.js';

const audioExtensions = new Set([
  '.mp3',
  '.m4a',
  '.opus',
  '.ogg',
  '.flac',
  '.wav',
  '.aiff',
  '.aif',
  '.aac',
  '.alac',
  '.wma',
  '.webm',
]);
export class Library {
  constructor(
    readonly store: Store,
    private readonly audio: AudioProcessor,
  ) {}
  async index(file: string, signal?: AbortSignal): Promise<LibraryTrack> {
    const absolute = expandPath(file),
      fileStat = await lstat(absolute);
    if (fileStat.isSymbolicLink() || !fileStat.isFile())
      throw new MusicDLError('Import a regular audio file; symlinks are skipped.', 'UNSAFE_PATH');
    const canonical = await realpath(absolute),
      existing = this.store.trackByPath(canonical);
    if (existing && existing.size === fileStat.size && existing.mtime === fileStat.mtimeMs)
      return existing;
    const info = await this.audio.probe(canonical, signal);
    return this.store.upsertTrack({
      id: existing?.id ?? randomUUID(),
      path: canonical,
      title: cleanText(info.tags.title ?? path.basename(canonical, path.extname(canonical))),
      artist: cleanText(info.tags.artist ?? 'Unknown Artist'),
      album: cleanText(info.tags.album ?? ''),
      duration: info.duration,
      codec: info.codec,
      bitrate: info.bitrate,
      size: fileStat.size,
      mtime: fileStat.mtimeMs,
      sourceKey: existing?.sourceKey,
      isrc: info.tags.isrc ?? existing?.isrc,
      hash: await hashFile(canonical),
    });
  }
  async import(
    input: string,
    options: {
      copyTo?: string | undefined;
      signal?: AbortSignal | undefined;
      progress?: ((count: number, file: string) => void) | undefined;
    } = {},
  ): Promise<{ tracks: LibraryTrack[]; errors: string[] }> {
    const root = expandPath(input),
      tracks: LibraryTrack[] = [],
      errors: string[] = [];
    let visited = 0;
    const walk = async (file: string): Promise<void> => {
      options.signal?.throwIfAborted();
      if (++visited > 100_000)
        throw new MusicDLError(
          'Import exceeds 100,000 entries. Import smaller directories separately.',
          'IMPORT_LIMIT',
        );
      const stats = await lstat(file);
      if (stats.isSymbolicLink()) {
        errors.push(`Skipped symlink: ${file}`);
        return;
      }
      if (stats.isDirectory()) {
        for (const name of (await readdir(file)).sort()) {
          if (!name.startsWith('.')) await walk(path.join(file, name));
        }
        return;
      }
      if (!stats.isFile() || !audioExtensions.has(path.extname(file).toLowerCase())) return;
      try {
        let target = file;
        if (options.copyTo) {
          target = path.join(
            expandPath(options.copyTo),
            safeSegment(path.basename(file, path.extname(file))) + path.extname(file).toLowerCase(),
          );
          await ensureSafeParent(expandPath(options.copyTo), target);
          await copyFile(file, target, constants.COPYFILE_EXCL);
        }
        tracks.push(await this.index(target, options.signal));
        options.progress?.(tracks.length, target);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await walk(root);
    return { tracks, errors };
  }
  planOrganization(
    tracks: LibraryTrack[],
    root: string,
    structure: 'flat' | 'artist-album',
  ): PlanEntry[] {
    const destinationRoot = expandPath(root),
      seen = new Set<string>();
    return tracks
      .map((track) => {
        const directory =
          structure === 'artist-album'
            ? path.join(
                destinationRoot,
                safeSegment(track.artist),
                safeSegment(track.album || 'Unknown Album'),
              )
            : destinationRoot;
        const destination = path.join(
          directory,
          `${safeSegment(`${track.title} - ${track.artist}`)}${path.extname(track.path).toLowerCase()}`,
        );
        const key = process.platform === 'linux' ? destination : destination.toLocaleLowerCase();
        if (seen.has(key))
          throw new MusicDLError(
            'Multiple tracks would use the same filename. Correct metadata first.',
            'COLLISION',
          );
        seen.add(key);
        return { source: track.path, destination };
      })
      .filter((entry) => entry.source !== entry.destination);
  }
  async organize(plan: PlanEntry[], destinationRoot: string): Promise<void> {
    for (const entry of plan) {
      if (await exists(entry.destination))
        throw new MusicDLError(`Destination already exists: ${entry.destination}`, 'EXISTS');
      const stats = await lstat(entry.source);
      if (!stats.isFile() || stats.isSymbolicLink())
        throw new MusicDLError('Source changed or contains a symlink.', 'UNSAFE_PATH');
    }
    for (const entry of plan) {
      await ensureSafeParent(destinationRoot, entry.destination);
      const track = this.store.trackByPath(entry.source);
      await publishExclusive(entry.source, entry.destination);
      if (track) this.store.updateTrackPath(track.id, entry.destination);
    }
  }
  async correct(
    id: string,
    corrections: {
      title?: string | undefined;
      artist?: string | undefined;
      album?: string | undefined;
    },
    writeTags = false,
  ): Promise<LibraryTrack> {
    const current = this.store.track(id);
    if (!current) throw new MusicDLError('Library track not found.', 'NOT_FOUND');
    const updated = { ...current };
    for (const key of ['title', 'artist', 'album'] as const)
      if (corrections[key] !== undefined) updated[key] = cleanText(corrections[key]!).trim();
    if (!updated.title || !updated.artist)
      throw new MusicDLError('Title and artist cannot be empty.', 'METADATA');
    if (writeTags) {
      const before = await lstat(current.path);
      if (!before.isFile() || before.isSymbolicLink())
        throw new MusicDLError('Unsafe source file.', 'UNSAFE_PATH');
      const staging = await mkdtemp(path.join(path.dirname(current.path), '.musicdl-edit-'));
      try {
        const track: Track = {
          key: current.sourceKey ?? current.id,
          id: current.id,
          provider: 'ytdlp',
          url: 'https://example.invalid',
          title: updated.title,
          artist: updated.artist,
          album: updated.album,
          confidence: 'manual',
        };
        const processed = await this.audio.process(current.path, staging, 'original', track);
        if (path.extname(current.path).slice(1).toLowerCase() !== processed.extension)
          throw new MusicDLError(
            'Tag writing would change this container. Export a converted copy instead.',
            'FORMAT',
          );
        const now = await stat(current.path);
        if (now.size !== before.size || now.mtimeMs !== before.mtimeMs)
          throw new MusicDLError(
            'The audio file changed while editing. Try again.',
            'FILE_CHANGED',
          );
        const backup = `${current.path}.musicdl-backup-${randomUUID()}`;
        await copyFile(current.path, backup, constants.COPYFILE_EXCL);
        await rename(processed.file, current.path);
        const after = await stat(current.path);
        updated.size = after.size;
        updated.mtime = after.mtimeMs;
        updated.hash = await hashFile(current.path);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    return this.store.upsertTrack(updated);
  }
  async missing(): Promise<LibraryTrack[]> {
    const out: LibraryTrack[] = [];
    for (const track of this.store.library()) if (!(await exists(track.path))) out.push(track);
    return out;
  }
  async convert(
    id: string,
    format: AudioFormat,
    destinationRoot: string,
    signal?: AbortSignal,
  ): Promise<LibraryTrack> {
    const source = this.store.track(id);
    if (!source) throw new MusicDLError('Library track not found.', 'NOT_FOUND');
    const root = expandPath(destinationRoot);
    await mkdir(root, { recursive: true });
    const staging = await mkdtemp(path.join(root, '.musicdl-convert-'));
    try {
      const track: Track = {
        key: source.sourceKey ?? source.id,
        id: source.id,
        provider: 'ytdlp',
        url: 'https://example.invalid',
        title: source.title,
        artist: source.artist,
        album: source.album,
        isrc: source.isrc,
        confidence: 'manual',
      };
      const processed = await this.audio.process(source.path, staging, format, track, signal);
      const destination = path.join(
        root,
        `${safeSegment(`${source.title} - ${source.artist}`)}.${processed.extension}`,
      );
      await ensureSafeParent(root, destination);
      await publishExclusive(processed.file, destination);
      const indexed = await this.index(destination, signal);
      return this.store.upsertTrack({ ...indexed, sourceKey: source.sourceKey, isrc: source.isrc });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async exportManifest(file: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await mkdir(path.dirname(expandPath(file)), { recursive: true });
    await writeFile(
      expandPath(file),
      JSON.stringify({ version: 1, tracks: this.store.library() }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  }
}
