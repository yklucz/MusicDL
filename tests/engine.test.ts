import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/storage/store.js';
import { DownloadManager } from '../src/downloads/manager.js';
import { defaults } from '../src/settings.js';
import { MusicDLError } from '../src/core/errors.js';
import type { DownloadPipeline } from '../src/downloads/manager.js';
import type { Track } from '../src/core/types.js';
import { hashFile } from '../src/core/files.js';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const track = (id: string): Track => ({
  id,
  key: `youtube:${id}`,
  provider: 'youtube',
  url: `https://youtube.com/watch?v=${id}`,
  title: `Song ${id}`,
  artist: 'Artist',
  confidence: 'provider',
});
async function fixture(pipeline: DownloadPipeline, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'musicdl-engine-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  stores.push(store);
  const config = {
    ...defaults(root),
    downloadsDir: path.join(root, 'downloads'),
    libraryDirs: [path.join(root, 'library')],
    ...extra,
  };
  const manager = new DownloadManager(store, config, pipeline, root);
  return { root, store, config, manager };
}
const filePipeline: DownloadPipeline = async (_job, staging, signal, update) => {
  signal.throwIfAborted();
  update({ stage: 'processing', percent: 100 });
  const file = path.join(staging, 'processed.mp3');
  await writeFile(file, 'authorized test audio');
  return {
    file,
    extension: 'mp3',
    info: { duration: 1, codec: 'mp3', bitrate: 128, tags: {}, hasArtwork: false },
  };
};

describe('durable download engine', () => {
  it('deduplicates the same recording ISRC across distinct selected provider IDs', async () => {
    const { manager } = await fixture(filePipeline);
    const result = await manager.enqueue(
      [
        { ...track('a'), isrc: 'US1234567890' },
        { ...track('b'), isrc: 'US1234567890' },
      ],
      'mp3',
    );
    expect(result.added).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });
  it('allows a different explicitly requested format but skips the same format', async () => {
    const { manager, store, root } = await fixture(filePipeline);
    const existing = path.join(root, 'source.opus');
    await writeFile(existing, 'opus source');
    store.upsertTrack({
      id: 'existing',
      path: existing,
      title: 'Song a',
      artist: 'Artist',
      album: '',
      duration: 1,
      codec: 'opus',
      bitrate: 160,
      size: 11,
      mtime: 0,
      sourceKey: 'youtube:a',
    });
    expect((await manager.enqueue([track('a')], 'opus')).skipped).toHaveLength(1);
    expect((await manager.enqueue([track('a')], 'mp3')).added).toHaveLength(1);
  });
  it('waits for a remotely cancelled pipeline and never requeues it', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pipeline: DownloadPipeline = async (_job, _stage, signal) => {
      started();
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 30), {
          once: true,
        }),
      );
      throw new Error('unreachable');
    };
    const { manager, store, config, root } = await fixture(pipeline);
    const remote = new DownloadManager(store, config, pipeline, root);
    const { added } = await manager.enqueue([track('a')], 'mp3');
    await manager.start();
    await ready;
    await remote.cancel(added[0]!.id);
    await manager.drain();
    await manager.stop();
    expect(store.jobs()[0]?.status).toBe('cancelled');
  });
  it('persists the queue and deduplicates repeated selected track identities', async () => {
    const { manager, store } = await fixture(filePipeline);
    const first = await manager.enqueue([track('a'), track('a')], 'mp3');
    expect(first.added).toHaveLength(1);
    expect(first.skipped).toHaveLength(1);
    expect(store.jobs()[0]?.status).toBe('queued');
    const second = await manager.enqueue([track('a')], 'mp3');
    expect(second.added).toHaveLength(0);
  });
  it('finishes real file publication and indexes history and library in one transaction', async () => {
    const { manager, store } = await fixture(filePipeline);
    await manager.enqueue([track('a')], 'mp3');
    await manager.start();
    await manager.drain();
    await manager.stop();
    const job = store.jobs()[0]!;
    expect(job.status).toBe('completed');
    expect(await readFile(job.outputPath!, 'utf8')).toBe('authorized test audio');
    expect(store.library()).toHaveLength(1);
    expect(store.history()).toHaveLength(1);
    expect((await manager.enqueue([track('a')], 'mp3')).skipped).toHaveLength(1);
  });
  it('respects concurrency while keeping independent jobs alive', async () => {
    let active = 0,
      peak = 0;
    const pipeline: DownloadPipeline = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      try {
        return await filePipeline(...args);
      } finally {
        active--;
      }
    };
    const { manager, store } = await fixture(pipeline, { concurrency: 2 });
    await manager.enqueue(['a', 'b', 'c', 'd'].map(track), 'mp3');
    await manager.start();
    await manager.drain();
    await manager.stop();
    expect(peak).toBe(2);
    expect(store.jobs().filter((j) => j.status === 'completed')).toHaveLength(4);
  });
  it('retries transient failures with backoff and preserves attempt history', async () => {
    let calls = 0;
    const pipeline: DownloadPipeline = async (...args) => {
      if (++calls < 3) throw new MusicDLError('offline', 'NETWORK', true);
      return filePipeline(...args);
    };
    const { manager, store } = await fixture(pipeline, { retryBaseMs: 10, maxRetries: 3 });
    await manager.enqueue([track('a')], 'mp3');
    await manager.start();
    await manager.drain();
    await manager.stop();
    expect(calls).toBe(3);
    expect(store.jobs()[0]?.status).toBe('completed');
    expect(store.history().map((h) => h.status)).toEqual(['completed', 'retrying', 'retrying']);
  });
  it('cancels the active subprocess pipeline and never publishes its file', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pipeline: DownloadPipeline = async (_job, _stage, signal) => {
      started();
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      throw new Error('unreachable');
    };
    const { manager, store } = await fixture(pipeline);
    const { added } = await manager.enqueue([track('a')], 'mp3');
    await manager.start();
    await ready;
    await manager.cancel(added[0]!.id);
    await manager.drain();
    await manager.stop();
    expect(store.jobs()[0]?.status).toBe('cancelled');
    expect(store.library()).toHaveLength(0);
  });
  it('recovers interrupted jobs on startup', async () => {
    const { manager, store } = await fixture(filePipeline);
    const { added } = await manager.enqueue([track('a')], 'mp3');
    store.updateJob(added[0]!.id, { status: 'downloading' });
    await manager.start();
    await manager.drain();
    await manager.stop();
    expect(store.jobs()[0]?.status).toBe('completed');
  });
  it('recovers a crash after publication without redownloading or losing codec information', async () => {
    let calls = 0;
    const { manager, store, config } = await fixture(async (...args) => {
      calls++;
      return filePipeline(...args);
    });
    const { added } = await manager.enqueue([track('a')], 'original');
    await mkdir(config.downloadsDir, { recursive: true });
    const outputPath = path.join(config.downloadsDir, 'Song a - Artist.opus');
    await writeFile(outputPath, 'published before crash');
    store.updateJob(added[0]!.id, {
      status: 'processing',
      outputPath,
      fileHash: await hashFile(outputPath),
      audioInfo: { duration: 12, codec: 'opus', bitrate: 160 },
    });
    await manager.start();
    await manager.drain();
    await manager.stop();
    expect(calls).toBe(0);
    expect(store.jobs()[0]?.status).toBe('completed');
    expect(store.library()[0]?.codec).toBe('opus');
    expect(store.library()[0]?.duration).toBe(12);
  });
  it('never overwrites an existing filename and reports the conflict', async () => {
    const { manager, store, config } = await fixture(filePipeline);
    await mkdir(config.downloadsDir, { recursive: true });
    const original = path.join(config.downloadsDir, 'Song a - Artist.mp3');
    await writeFile(original, 'my existing file');
    await manager.enqueue([track('a')], 'mp3');
    await manager.start();
    await manager.drain();
    await manager.stop();
    expect(await readFile(original, 'utf8')).toBe('my existing file');
    expect(store.jobs()[0]?.status).toBe('failed');
    expect(store.jobs()[0]?.error).toMatch(/exist/i);
  });
});
