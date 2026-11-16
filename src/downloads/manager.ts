import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import type { AudioFormat, Job, LibraryTrack, Progress, Track } from '../core/types.js';
import type { Settings } from '../settings.js';
import type { ProcessedAudio } from '../audio/processor.js';
import { filenameFor } from '../audio/processor.js';
import { abortError, errorMessage, MusicDLError } from '../core/errors.js';
import { ensureSafeParent, exists, publishExclusive, redact, safeSegment } from '../core/safety.js';
import { hashFile } from '../core/files.js';
import { Store } from '../storage/store.js';
import { WorkerLock } from '../storage/lock.js';
import { renderM3u } from '../playlists.js';
import { matchesFormat } from '../audio/formats.js';

export type DownloadPipeline = (
  job: Job,
  staging: string,
  signal: AbortSignal,
  update: (progress: Progress) => void,
) => Promise<ProcessedAudio>;
const pending = new Set(['queued', 'retrying', 'downloading', 'processing']);
export class DownloadManager extends EventEmitter {
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly lock: WorkerLock;
  private running = false;
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;
  private playlistSync: Promise<void> = Promise.resolve();
  constructor(
    readonly store: Store,
    readonly config: Settings,
    private readonly pipeline: DownloadPipeline,
    private readonly stateDir: string,
  ) {
    super();
    this.lock = new WorkerLock(path.join(stateDir, 'worker.lock'));
  }
  async enqueue(
    tracks: Track[],
    format: AudioFormat,
    batchId?: string,
  ): Promise<{ added: Job[]; skipped: Track[] }> {
    const added: Job[] = [],
      skipped: Track[] = [];
    for (const track of tracks) {
      const duplicates = this.store.duplicatesFor(track);
      let downloaded = false;
      for (const duplicate of duplicates)
        if (this.compatible(duplicate, format) && (await exists(duplicate.path))) {
          downloaded = true;
          break;
        }
      if (downloaded || this.store.activeDuplicate(track, format)) {
        skipped.push(track);
        continue;
      }
      const now = Date.now();
      const job: Job = {
        id: randomUUID(),
        track,
        format,
        status: 'queued',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: 0,
        batchId,
      };
      try {
        this.store.addJob(job);
        added.push(job);
      } catch (error) {
        if ((error as Error).message.includes('UNIQUE constraint')) skipped.push(track);
        else throw error;
      }
    }
    this.emit('change');
    this.tick();
    return { added, skipped };
  }
  async start(): Promise<void> {
    if (this.running) return;
    await this.lock.acquire();
    this.stopping = false;
    try {
      await mkdir(path.join(this.stateDir, 'staging'), { recursive: true, mode: 0o700 });
      for (const job of this.store.jobs())
        if (job.status === 'downloading' || job.status === 'processing') {
          if (
            job.outputPath &&
            job.fileHash &&
            (await exists(job.outputPath)) &&
            (await hashFile(job.outputPath)) === job.fileHash
          ) {
            const stats = await stat(job.outputPath);
            this.complete(
              job,
              job.audioInfo ?? {
                duration: job.track.duration ?? 0,
                codec: job.format,
                bitrate: job.track.source?.bitrate ?? 0,
              },
              stats,
            );
            await this.cleanup(job.id);
          } else
            this.store.updateJob(job.id, {
              status: 'queued',
              progress: undefined,
              error: 'Recovered after interruption.',
            });
        }
      this.running = true;
      this.timer = setInterval(() => this.tick(), 50);
      this.tick();
      await this.syncPlaylists();
    } catch (error) {
      await this.lock.release();
      throw error;
    }
  }
  async stop(): Promise<void> {
    if (!this.running && !this.stopping) return;
    this.stopping = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    for (const [id, { controller }] of this.active)
      controller.abort(
        this.store.job(id)?.status === 'cancelled'
          ? abortError()
          : new MusicDLError('Application closed; queued for recovery.', 'STOPPED'),
      );
    await Promise.all([...this.active.values()].map((value) => value.promise));
    await this.lock.release();
    this.stopping = false;
  }
  async drain(signal?: AbortSignal): Promise<void> {
    while (this.active.size || this.store.jobs().some((job) => pending.has(job.status))) {
      if (signal?.aborted) throw abortError();
      if (!this.running) throw new MusicDLError('Queue worker is not running.', 'QUEUE_STOPPED');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    await this.syncPlaylists();
  }
  async syncPlaylists(): Promise<void> {
    const next = this.playlistSync.then(() => this.finalizePlaylists());
    this.playlistSync = next.catch(() => {});
    return next;
  }
  private async finalizePlaylists(): Promise<void> {
    const jobs = this.store.jobs();
    for (const batch of this.store.downloadPlaylists().filter((b) => b.status === 'pending')) {
      if (
        batch.tracks.some((track) =>
          jobs.some((job) => job.track.key === track.key && pending.has(job.status)),
        )
      )
        continue;
      try {
        const tracks: LibraryTrack[] = [];
        for (const source of batch.tracks)
          for (const match of this.store.duplicatesFor(source))
            if (this.compatible(match, batch.format) && (await exists(match.path))) {
              tracks.push(match);
              break;
            }
        this.store.setPlaylistTracks(
          batch.playlistId,
          tracks.map((track) => track.id),
        );
        await ensureSafeParent(this.config.downloadsDir, batch.outputPath);
        await writeFile(batch.outputPath, renderM3u(tracks, path.dirname(batch.outputPath), true), {
          flag: 'wx',
          mode: 0o600,
        });
        this.store.finishDownloadPlaylist(
          batch.id,
          'completed',
          tracks.length < batch.tracks.length
            ? `${tracks.length}/${batch.tracks.length} tracks downloaded; unavailable or failed tracks omitted.`
            : undefined,
        );
      } catch (error) {
        this.store.finishDownloadPlaylist(batch.id, 'failed', redact(errorMessage(error)));
      }
    }
  }
  async cancel(id: string): Promise<void> {
    const job = this.store.job(id);
    if (!job || !pending.has(job.status)) return;
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(abortError());
      await active.promise;
    } else {
      this.store.updateJob(id, {
        status: 'cancelled',
        error: 'Cancelled by user.',
        progress: undefined,
      });
      this.store.addHistory(job, 'cancelled');
      if (!['downloading', 'processing'].includes(job.status)) await this.cleanup(id);
    }
    this.emit('change');
  }
  retry(id: string): void {
    const job = this.store.job(id);
    if (!job || !['failed', 'cancelled'].includes(job.status))
      throw new MusicDLError('Only failed or cancelled jobs can be retried.', 'SELECTION');
    if (this.store.activeDuplicate(job.track, job.format))
      throw new MusicDLError('This track is already queued.', 'DUPLICATE');
    this.store.updateJob(id, {
      status: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      error: undefined,
      progress: undefined,
      outputPath: undefined,
      fileHash: undefined,
    });
    this.emit('change');
    this.tick();
  }
  private tick(): void {
    if (!this.running || this.stopping) return;
    const jobs = this.store.jobs();
    for (const [id, active] of this.active)
      if (jobs.find((job) => job.id === id)?.status === 'cancelled')
        active.controller.abort(abortError());
    for (const job of jobs) {
      if (this.active.size >= this.config.concurrency) break;
      if (
        !['queued', 'retrying'].includes(job.status) ||
        job.nextAttemptAt > Date.now() ||
        this.active.has(job.id)
      )
        continue;
      const controller = new AbortController();
      this.store.updateJob(job.id, {
        status: 'downloading',
        attempts: job.attempts + 1,
        error: undefined,
      });
      const promise = this.execute(
        { ...job, attempts: job.attempts + 1 },
        controller.signal,
      ).finally(() => {
        this.active.delete(job.id);
        this.emit('change');
      });
      this.active.set(job.id, { controller, promise });
      this.emit('job-start', job.id);
    }
  }
  private async execute(job: Job, signal: AbortSignal): Promise<void> {
    const staging = path.join(this.stateDir, 'staging', job.id);
    const outputRoot = this.config.downloadsDir,
      structure = this.config.structure,
      template = this.config.filenameTemplate;
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const processed = await this.pipeline(job, staging, signal, (progress) => {
        if (this.store.job(job.id)?.status === 'cancelled') {
          this.active.get(job.id)?.controller.abort(abortError());
          return;
        }
        this.store.updateJob(job.id, {
          progress,
          track: job.track,
          ...(progress.stage === 'processing' ? { status: 'processing' as const } : {}),
        });
        this.emit('change');
      });
      signal.throwIfAborted();
      if (this.store.job(job.id)?.status === 'cancelled')
        this.active.get(job.id)?.controller.abort(abortError());
      signal.throwIfAborted();
      const directory =
        structure === 'artist-album'
          ? path.join(
              outputRoot,
              safeSegment(job.track.artist ?? 'Unknown Artist'),
              safeSegment(job.track.album ?? 'Unknown Album'),
            )
          : outputRoot;
      const outputPath = path.join(
        directory,
        filenameFor(job.track, processed.extension, template),
      );
      await ensureSafeParent(outputRoot, outputPath);
      if (await exists(outputPath))
        throw new MusicDLError(
          `File already exists: ${path.basename(outputPath)}. Change the filename template or import the existing file.`,
          'EXISTS',
        );
      const fileHash = await hashFile(processed.file);
      this.store.updateJob(job.id, {
        status: 'processing',
        track: job.track,
        outputPath,
        fileHash,
        audioInfo: {
          codec: processed.info.codec,
          duration: processed.info.duration,
          bitrate: processed.info.bitrate,
        },
      });
      signal.throwIfAborted();
      try {
        await publishExclusive(processed.file, outputPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new MusicDLError(
            `File already exists: ${path.basename(outputPath)}. It was not overwritten.`,
            'EXISTS',
          );
        throw error;
      }
      job.outputPath = outputPath;
      job.fileHash = fileHash;
      this.complete(job, processed.info, await stat(outputPath));
      await this.cleanup(job.id).catch((error) =>
        this.store.addHistory(job, 'cleanup-warning', redact(errorMessage(error))),
      );
      await this.syncPlaylists();
    } catch (error) {
      const stopped =
        signal.aborted && signal.reason instanceof MusicDLError && signal.reason.code === 'STOPPED';
      const cancelled = signal.aborted && !stopped;
      const retryable =
        !cancelled &&
        !stopped &&
        error instanceof MusicDLError &&
        error.retryable &&
        job.attempts <= this.config.maxRetries;
      const status = stopped
        ? 'queued'
        : cancelled
          ? 'cancelled'
          : retryable
            ? 'retrying'
            : 'failed';
      const message = cancelled ? 'Cancelled by user.' : redact(errorMessage(error));
      const nextAttemptAt = retryable
        ? Date.now() + Math.min(60_000, this.config.retryBaseMs * 2 ** (job.attempts - 1))
        : 0;
      this.store.transaction(() => {
        this.store.updateJob(job.id, {
          status,
          error: message,
          nextAttemptAt,
          progress: undefined,
        });
        this.store.addHistory(job, status, message);
      });
      // Never remove published output. Staging is owned by this job only.
      if (cancelled || status === 'failed') await this.cleanup(job.id).catch(() => {});
    }
    this.emit('change');
  }
  private complete(
    job: Job,
    info: { duration: number; codec: string; bitrate: number },
    stats: { size: number; mtimeMs: number },
  ): void {
    const track: LibraryTrack = {
      id: randomUUID(),
      path: job.outputPath!,
      title: job.track.title,
      artist: job.track.artist ?? 'Unknown Artist',
      album: job.track.album ?? '',
      duration: info.duration,
      codec: info.codec,
      bitrate: info.bitrate,
      size: stats.size,
      mtime: stats.mtimeMs,
      sourceKey: job.track.key,
      isrc: job.track.isrc,
      hash: job.fileHash,
    };
    this.store.transaction(() => {
      this.store.upsertTrack(track);
      this.store.updateJob(job.id, {
        status: 'completed',
        error: undefined,
        progress: { percent: 100, stage: 'completed' },
      });
      this.store.addHistory(job, 'completed', job.outputPath);
    });
  }
  private compatible(track: LibraryTrack, format: AudioFormat): boolean {
    return (
      matchesFormat(track, format) ||
      (format === 'original' &&
        this.store
          .jobs()
          .some(
            (job) =>
              job.format === 'original' &&
              job.status === 'completed' &&
              job.outputPath === track.path,
          ))
    );
  }
  private async cleanup(id: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new MusicDLError('Invalid staging identity.', 'UNSAFE_PATH');
    await rm(path.join(this.stateDir, 'staging', id), { recursive: true, force: true });
  }
}
