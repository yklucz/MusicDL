import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { MusicDL } from '../src/app.js';
import { defaults } from '../src/settings.js';
import { Store } from '../src/storage/store.js';
import { ProcessRunner } from '../src/core/process.js';
import { AudioProcessor } from '../src/audio/processor.js';

const available = ['yt-dlp', 'ffmpeg', 'ffprobe'].every(
  (tool) =>
    spawnSync(tool, [tool.startsWith('ff') ? '-version' : '--version'], { stdio: 'ignore' })
      .status === 0,
);
describe.skipIf(!available)('authorized local HTTP audio end to end', () => {
  let root: string, baseUrl: string, app: MusicDL;
  const server = createServer((request, response) => {
    const image = request.url === '/cover.png',
      file = path.join(root, image ? 'cover.png' : 'authorized-tone.wav');
    void stat(file)
      .then((info) => {
        response.writeHead(200, {
          'Content-Type': image ? 'image/png' : 'audio/wav',
          'Content-Length': info.size,
        });
        if (request.method === 'HEAD') response.end();
        else createReadStream(file).pipe(response);
      })
      .catch(() => {
        response.writeHead(404);
        response.end();
      });
  });
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'musicdl-e2e-'));
    const runner = new ProcessRunner(),
      config = {
        ...defaults(root),
        downloadsDir: path.join(root, 'downloads'),
        libraryDirs: [path.join(root, 'library')],
        allowLocalUrls: true,
      };
    await runner.run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1.5',
      '-c:a',
      'pcm_s16le',
      path.join(root, 'authorized-tone.wav'),
    ]);
    await runner.run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=teal:s=100x100',
      '-frames:v',
      '1',
      path.join(root, 'cover.png'),
    ]);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const state = path.join(root, 'state');
    app = new MusicDL(
      config,
      {
        config: state,
        state,
        settings: path.join(state, 'config.json'),
        database: path.join(state, 'db.sqlite'),
        staging: path.join(state, 'staging'),
        lock: path.join(state, 'worker.lock'),
      },
      new Store(path.join(state, 'db.sqlite')),
      runner,
    );
  });
  afterAll(async () => {
    if (app) await app.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('resolves, downloads, tags, embeds artwork, indexes and exports an ordered M3U8', async () => {
    const resolved = await app.resolver.resolve(`${baseUrl}/authorized-tone.wav`);
    expect(resolved.kind).toBe('track');
    if (resolved.kind !== 'track') throw new Error('Expected track');
    Object.assign(resolved.track, {
      title: 'Bài kiểm tra',
      artist: 'MusicDL Test',
      album: 'Authorized fixtures',
      confidence: 'manual',
      artworkUrl: `${baseUrl}/cover.png`,
    });
    app.store.createDownloadPlaylist(
      'Integration',
      [resolved.track],
      path.join(app.config.downloadsDir, 'Playlists', 'Integration.m3u8'),
    );
    await app.manager.enqueue([resolved.track], 'mp3');
    await app.manager.start();
    await app.manager.drain();
    await app.manager.stop();
    const job = app.store.jobs()[0]!;
    expect(job.error).toBeUndefined();
    expect(job.status).toBe('completed');
    const output = job.outputPath!;
    const bytes = await readFile(output);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x49, 0x44, 0x33, 3]));
    const info = await app.audio.probe(output);
    expect(info.codec).toBe('mp3');
    expect(info.duration).toBeGreaterThan(1);
    expect(info.tags.title).toBe('Bài kiểm tra');
    expect(info.tags.artist).toBe('MusicDL Test');
    expect(info.hasArtwork).toBe(true);
    expect(app.store.library()).toHaveLength(1);
    expect(app.store.history()[0]?.status).toBe('completed');
    const playlist = await readFile(
      path.join(app.config.downloadsDir, 'Playlists', 'Integration.m3u8'),
      'utf8',
    );
    expect(playlist).toContain('../Bài kiểm tra - MusicDL Test.mp3');
    expect(await readdir(app.paths.staging)).toEqual([]);
    expect((await app.manager.enqueue([resolved.track], 'mp3')).skipped).toHaveLength(1);
  });
  it('processes genuine lossless audio to FLAC and preserves AAC and Opus when remuxing', async () => {
    const runner = new ProcessRunner(),
      processor = new AudioProcessor(runner, app.config.tools, true);
    const track = {
      key: 'fixture',
      id: 'fixture',
      provider: 'ytdlp' as const,
      url: `${baseUrl}/authorized-tone.wav`,
      title: 'Fixture',
      artist: 'Test',
      confidence: 'manual' as const,
    };
    const stage = await mkdtemp(path.join(root, 'formats-'));
    const flac = await processor.process(
      path.join(root, 'authorized-tone.wav'),
      stage,
      'flac',
      track,
    );
    expect(flac.info.codec).toBe('flac');
    const m4a = await processor.process(
      path.join(root, 'authorized-tone.wav'),
      stage,
      'm4a',
      track,
    );
    expect(m4a.info.codec).toBe('aac');
    const opus = await processor.process(path.join(root, 'authorized-tone.wav'), stage, 'opus', {
      ...track,
      artworkUrl: `${baseUrl}/cover.png`,
    });
    expect(opus.info.codec).toBe('opus');
    expect(opus.info.hasArtwork).toBe(true);
    const rewritten = await processor.process(
      opus.file,
      await mkdtemp(path.join(root, 'retag-')),
      'original',
      { ...track, title: 'Corrected' },
    );
    expect(rewritten.info.hasArtwork).toBe(true);
    expect(rewritten.info.tags.title).toBe('Corrected');
    const local = await app.library.index(opus.file);
    const converted = await app.library.convert(local.id, 'mp3', path.join(root, 'converted'));
    expect(converted.codec).toBe('mp3');
    expect((await app.audio.probe(converted.path)).hasArtwork).toBe(true);
    await expect(
      processor.process(opus.file, await mkdtemp(path.join(root, 'lossy-')), 'flac', track),
    ).rejects.toThrow('lossless');
  });
  it('downloads a real lossless URL to FLAC without requiring codec metadata in the URL resolver', async () => {
    const resolved = await app.resolver.resolve(`${baseUrl}/lossless-tone.wav`);
    if (resolved.kind !== 'track') throw new Error('Expected track');
    resolved.track.title = 'Lossless fixture';
    resolved.track.confidence = 'manual';
    await app.manager.enqueue([resolved.track], 'flac');
    await app.manager.start();
    await app.manager.drain();
    await app.manager.stop();
    const job = app.store.jobs().find((item) => item.track.title === 'Lossless fixture')!;
    expect(job.error).toBeUndefined();
    expect(job.status).toBe('completed');
    expect((await app.audio.probe(job.outputPath!)).codec).toBe('flac');
  });
});
