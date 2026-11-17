import { describe, expect, it, vi } from 'vitest';
import { writeFile, mkdtemp, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Resolver } from '../src/resolver.js';
import type { RunOptions, RunResult, Runner } from '../src/core/process.js';
import { MusicDLError } from '../src/core/errors.js';
import type { MetadataProgress } from '../src/providers/spotify.js';
import { spotifyMetadata } from '../src/providers/metadata.js';
const tools = { ytdlp: 'yt-dlp', spotdl: 'spotdl', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
const playlistUrl = 'https://open.spotify.com/playlist/abcdefghijklmnopqrstuv';
const albumUrl = 'https://open.spotify.com/album/abcdefghijklmnopqrstuv';
function song(position: number, length: number) {
  return {
    name: `Bài ${position}`,
    artists: ['Artist'],
    album_name: 'Original Album',
    album_artist: 'Artist',
    url: `https://open.spotify.com/track/${position.toString(36).padStart(22, '0')}`,
    cover_url: 'https://i.scdn.co/image/original-artwork',
    list_name: 'Collection',
    list_length: length,
    list_position: position,
    track_number: position,
    disc_number: 1,
  };
}
class FileRunner implements Runner {
  args: string[] = [];
  constructor(
    readonly payload: unknown,
    readonly activity = 'MUSICDL_META INFO Found 2 songs in Collection (Playlist)',
  ) {}
  async run(_command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.args = args;
    options.onLine?.(this.activity);
    await writeFile(
      args[args.indexOf('--save-file') + 1]!,
      typeof this.payload === 'string' ? this.payload : JSON.stringify(this.payload),
    );
    return { stdout: this.activity, stderr: '' };
  }
}
describe('Spotify metadata retrieval', () => {
  it('uses the installed SDK for playlist pages, reports true counts and removes temporary metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'musicdl-sdk-test-'));
    try {
      const spotdl = path.join(root, process.platform === 'win32' ? 'spotdl.exe' : 'spotdl');
      const python = path.join(root, process.platform === 'win32' ? 'python.exe' : 'python');
      await writeFile(spotdl, '');
      await writeFile(python, '');
      let output: string | undefined;
      const events: (MetadataProgress | undefined)[] = [];
      const runner: Runner = {
        run: async (command, args, options) => {
          expect(await realpath(command)).toBe(await realpath(python));
          expect(args[0]).toBe('-u');
          expect(args[1]).toContain('spotify-playlist.py');
          expect(args).not.toContain('download');
          expect(args).not.toContain('--lyrics');
          output = args[args.indexOf('--output') + 1]!;
          options?.onLine?.('MUSICDL_META PAGE 0/0');
          await writeFile(
            output,
            JSON.stringify({
              schema: 'musicdl-spotify-playlist-v1',
              complete: true,
              total: 0,
              name: 'Empty',
              entries: [],
            }),
          );
          return { stdout: '', stderr: '' };
        },
      };
      const result = await new Resolver(runner, { ...tools, spotdl }).resolve(
        playlistUrl,
        undefined,
        (progress) => events.push(progress),
      );
      expect(result).toMatchObject({
        kind: 'collection',
        collection: { title: 'Empty', totalCount: 0, tracks: [] },
      });
      expect(events).toContainEqual(
        expect.objectContaining({ receivedTracks: 0, reportedTracks: 0 }),
      );
      expect(events.at(-1)).toBeUndefined();
      await expect(lstat(output!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('fails safely when a playlist installation cannot verify complete pages', async () => {
    const runner: Runner = { run: vi.fn() };
    await expect(
      new Resolver(runner, {
        ...tools,
        spotdl: path.join(tmpdir(), 'musicdl-missing', 'spotdl'),
      }).resolve(playlistUrl),
    ).rejects.toMatchObject({
      code: 'TOOL_MISSING',
      message: expect.stringContaining('pnpm setup:tools'),
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
  it.each([2, 1000])(
    'retains every entry, source order and release artwork for %i tracks',
    async (count) => {
      const runner = new FileRunner(
        Array.from({ length: count }, (_, i) => song(count - i, count)),
        `MUSICDL_META INFO Found ${count} songs in Collection (Playlist)`,
      );
      const result = await new Resolver(runner, tools).resolve(albumUrl);
      if (result.kind !== 'collection') throw new Error('Expected collection');
      expect(result.collection.totalCount).toBe(count);
      expect(result.collection.tracks).toHaveLength(count);
      expect(result.collection.tracks[0]?.title).toBe('Bài 1');
      expect(result.collection.tracks.at(-1)?.collectionPosition).toBe(count);
      expect(result.collection.tracks[0]?.album).toBe('Original Album');
      expect(result.collection.tracks[0]?.artworkUrl).toBe(
        'https://i.scdn.co/image/original-artwork',
      );
      expect(runner.args[0]).toBe('save');
      expect(runner.args).toContain('--lyrics');
      expect(
        runner.args.slice(runner.args.indexOf('--audio'), runner.args.indexOf('--audio') + 2),
      ).toEqual(['--audio', 'youtube']);
      expect(runner.args).not.toContain('--preload');
      expect(runner.args).not.toContain('--playlist-numbering');
    },
  );
  it.each([
    { name: 'a missing track', payload: [song(1, 2)] },
    { name: 'a null track', payload: [song(1, 2), null] },
    { name: 'invalid track metadata', payload: [song(1, 2), { ...song(2, 2), name: '' }] },
    { name: 'inconsistent totals', payload: [song(1, 2), song(2, 3)] },
    { name: 'a truncated JSON document', payload: '[{"name":"partial"}' },
  ])('rejects incomplete data: $name', async ({ payload }) => {
    await expect(new Resolver(new FileRunner(payload), tools).resolve(albumUrl)).rejects.toThrow(
      /metadata|incomplete/i,
    );
  });
  it.each([
    [song(1, 2), song(1, 2)],
    [song(1, 2), song(3, 2)],
  ])('rejects invalid CLI playlist positions defensively', (...payload) => {
    expect(() => spotifyMetadata(payload, 'playlist', playlistUrl, 2)).toThrow(/incomplete/i);
  });
  it('rejects omissions reported by spotDL even when it exits successfully', async () => {
    const runner = new FileRunner(
      [song(1, 2), song(2, 2)],
      'MUSICDL_META ERROR a song generated an exception',
    );
    await expect(new Resolver(runner, tools).resolve(albumUrl)).rejects.toThrow(/incomplete/i);
  });
  it('emits elapsed activity while the provider is silent and clears progress after cancellation', async () => {
    const events: (MetadataProgress | undefined)[] = [];
    const controller = new AbortController();
    const runner: Runner = {
      run: async (_command, _args, options) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener(
            'abort',
            () => reject(new MusicDLError('Cancelled', 'CANCELLED')),
            { once: true },
          ),
        ),
    };
    const pending = new Resolver(runner, tools).resolve(albumUrl, controller.signal, (progress) =>
      events.push(progress),
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(
      () => expect(events.some((event) => event && event.elapsedMs >= 500)).toBe(true),
      { timeout: 4000 },
    );
    controller.abort();
    await rejected;
    expect(events.some((event) => event?.stage === 'cancelled')).toBe(true);
    expect(events.at(-1)).toBeUndefined();
  });
  it('reports provider timeout and sanitized diagnostic context', async () => {
    const runner: Runner = {
      run: async (_command, _args, options) => {
        options?.onLine?.('Cookie: session=private-cookie');
        options?.onLine?.('MUSICDL_META INFO Found 2 songs');
        throw new MusicDLError('request timed out token=private-token', 'TIMEOUT', true);
      },
    };
    const events: (MetadataProgress | undefined)[] = [];
    let failure: unknown;
    try {
      await new Resolver(runner, tools).resolve(albumUrl, undefined, (event) => events.push(event));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect((failure as Error).message).toContain('Spotify album');
    expect((failure as Error).message).toContain('Found 2 songs');
    expect((failure as Error).message).not.toMatch(/private-cookie|private-token/);
    expect(events.at(-1)).toBeUndefined();
  });
  it('reports private or unavailable provider errors instead of leaving a loading state', async () => {
    const runner: Runner = {
      run: async () => {
        throw new MusicDLError('Private playlist: authentication required', 'UNAVAILABLE');
      },
    };
    const events: (MetadataProgress | undefined)[] = [];
    await expect(
      new Resolver(runner, tools).resolve(albumUrl, undefined, (event) => events.push(event)),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(events.some((event) => event?.stage === 'failed')).toBe(true);
    expect(events.at(-1)).toBeUndefined();
  });
});
