import { describe, expect, it } from 'vitest';
import { Resolver, selectTracks } from '../src/resolver.js';
import { ytDownloadArgs } from '../src/providers/ytdlp.js';
import { validateUrl, safeSegment } from '../src/core/safety.js';
import type { Runner, RunOptions, RunResult } from '../src/core/process.js';
import type { PromptPort } from '../src/prompts.js';

class MetadataRunner implements Runner {
  calls: string[][] = [];
  constructor(private readonly data: (args: string[]) => unknown) {}
  async run(_command: string, args: string[], _options?: RunOptions): Promise<RunResult> {
    this.calls.push(args);
    return { stdout: JSON.stringify(this.data(args)), stderr: '' };
  }
}
const video = {
  id: 'abcdefghijk',
  title: 'Đêm nhạc',
  artist: 'Nghệ sĩ',
  acodec: 'opus',
  abr: 160,
  ext: 'webm',
  webpage_url: 'https://www.youtube.com/watch?v=abcdefghijk',
};
const playlist = {
  _type: 'playlist',
  id: 'PL123',
  title: 'A collection',
  uploader: 'Creator',
  playlist_count: 3,
  entries: [
    { ...video, url: 'abcdefghijk' },
    { id: 'lmnopqrstuv', title: 'Another', url: 'lmnopqrstuv', ie_key: 'Youtube' },
    { id: 'xxxxxxxxxxx', title: '[Private video]', availability: 'private', url: 'xxxxxxxxxxx' },
  ],
};
const tools = { ytdlp: 'yt-dlp', spotdl: 'spotdl', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
const prompts = (choice = 'single', picks = ['youtube:lmnopqrstuv']): PromptPort => ({
  interactive: true,
  select: async () => choice,
  multiselect: async () => picks,
  confirm: async () => true,
  text: async () => '',
  note: () => {},
});

describe('universal input', () => {
  it('restores album and playlist order from spotDL positions after parallel metadata resolution', async () => {
    const first = {
      name: 'First',
      artists: ['Artist'],
      album_name: 'Album',
      disc_number: 1,
      track_number: 1,
      list_position: 1,
      url: 'https://open.spotify.com/track/1234567890123456789012',
    };
    const second = {
      ...first,
      name: 'Second',
      track_number: 2,
      list_position: 2,
      url: 'https://open.spotify.com/track/abcdefghijklmnopqrstuv',
    };
    for (const kind of ['album', 'playlist']) {
      const result = await new Resolver(new MetadataRunner(() => [second, first]), tools).resolve(
        `https://open.spotify.com/${kind}/abcdefghijklmnopqrstuv`,
      );
      if (result.kind !== 'collection') throw new Error('Expected collection');
      expect(result.collection.tracks.map((track) => track.title)).toEqual(['First', 'Second']);
    }
  });
  it('recognizes provider-confirmed YouTube Music OLAK albums and propagates the album title', async () => {
    const result = await new Resolver(
      new MetadataRunner(() => ({ ...playlist, id: 'OLAK5uy_fixture', album: undefined })),
      tools,
    ).resolve('https://music.youtube.com/playlist?list=OLAK5uy_fixture');
    if (result.kind !== 'collection') throw new Error('Expected collection');
    expect(result.collection.kind).toBe('album');
    expect(result.collection.tracks[0]?.album).toBe('A collection');
  });
  it('passes cancellation into mixed-link playlist metadata loading', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    class AbortRunner implements Runner {
      async run(_command: string, args: string[], options?: RunOptions): Promise<RunResult> {
        if (args.includes('--yes-playlist')) {
          received = options?.signal;
          controller.abort();
          options?.signal?.throwIfAborted();
        }
        return { stdout: JSON.stringify(video), stderr: '' };
      }
    }
    const resolver = new Resolver(new AbortRunner(), tools),
      result = await resolver.resolve('https://youtube.com/watch?v=abcdefghijk&list=PL123');
    await expect(
      selectTracks(resolver, result, { playlist: true }, prompts(), controller.signal),
    ).rejects.toThrow();
    expect(received).toBe(controller.signal);
  });
  it('resolves a standalone video using provider metadata', async () => {
    const runner = new MetadataRunner(() => video);
    const result = await new Resolver(runner, tools).resolve(
      'https://www.youtube.com/watch?v=abcdefghijk',
    );
    expect(result.kind).toBe('track');
    if (result.kind !== 'track') throw new Error('Expected track');
    expect(result.track.title).toBe('Đêm nhạc');
    expect(result.track.source?.bitrate).toBe(160);
    expect(runner.calls[0]).toContain('--no-playlist');
  });
  it('detects collections from metadata even on an otherwise unrecognized URL', async () => {
    const result = await new Resolver(new MetadataRunner(() => playlist), tools).resolve(
      'https://example.org/a-release',
    );
    expect(result.kind).toBe('collection');
    if (result.kind !== 'collection') throw new Error('Expected collection');
    expect(result.collection.tracks).toHaveLength(2);
    expect(result.collection.unavailableCount).toBe(1);
    expect(result.collection.creator).toBe('Creator');
  });
  it.each(['www.youtube.com', 'music.youtube.com', 'youtu.be'])(
    'keeps song and playlist context separate on %s',
    async (host) => {
      const runner = new MetadataRunner((args) =>
        args.includes('--yes-playlist') ? playlist : video,
      );
      const resolver = new Resolver(runner, tools);
      const path =
        host === 'youtu.be' ? '/abcdefghijk?list=PL123' : '/watch?v=abcdefghijk&list=PL123';
      const result = await resolver.resolve(`https://${host}${path}`);
      expect(result.kind).toBe('context');
      const selected = await selectTracks(resolver, result, {}, prompts());
      expect(selected.tracks.map((t) => t.id)).toEqual(['abcdefghijk']);
      expect(selected.tracks[0]?.url).toBe('https://www.youtube.com/watch?v=abcdefghijk');
      expect(runner.calls).toHaveLength(1);
      expect(ytDownloadArgs(selected.tracks[0]!, '/tmp/source.%(ext)s')).toContain('--no-playlist');
      expect(ytDownloadArgs(selected.tracks[0]!, '/tmp/source.%(ext)s').at(-1)).not.toContain(
        'list=',
      );
    },
  );
  it('only returns checked tracks when a mixed link chooses selection', async () => {
    const resolver = new Resolver(
      new MetadataRunner((args) => (args.includes('--yes-playlist') ? playlist : video)),
      tools,
    );
    const result = await resolver.resolve(
      'https://music.youtube.com/watch?v=abcdefghijk&list=PL123',
    );
    const selected = await selectTracks(resolver, result, {}, prompts('select'));
    expect(selected.tracks.map((t) => t.id)).toEqual(['lmnopqrstuv']);
  });
  it('requires an explicit override for a mixed link without a terminal', async () => {
    const resolver = new Resolver(new MetadataRunner(() => video), tools);
    const result = await resolver.resolve('https://youtube.com/watch?v=abcdefghijk&list=PL123');
    await expect(
      selectTracks(resolver, result, { yes: true }, { ...prompts(), interactive: false }),
    ).rejects.toThrow('--single');
    const selected = await selectTracks(
      resolver,
      result,
      { single: true },
      { ...prompts(), interactive: false },
    );
    expect(selected.tracks).toHaveLength(1);
  });
  it('explicit playlist override selects only resolved available entries', async () => {
    const resolver = new Resolver(
      new MetadataRunner((args) => (args.includes('--yes-playlist') ? playlist : video)),
      tools,
    );
    const result = await resolver.resolve('https://youtube.com/watch?v=abcdefghijk&list=PL123');
    const selected = await selectTracks(
      resolver,
      result,
      { playlist: true },
      { ...prompts(), interactive: false },
    );
    expect(selected.tracks.map((t) => t.id)).toEqual(['abcdefghijk', 'lmnopqrstuv']);
  });
  it('rejects single selection on a collection and conflicting flags', async () => {
    const resolver = new Resolver(new MetadataRunner(() => playlist), tools);
    const result = await resolver.resolve('https://youtube.com/playlist?list=PL123');
    await expect(selectTracks(resolver, result, { single: true }, prompts())).rejects.toThrow(
      'collection',
    );
    await expect(
      selectTracks(resolver, result, { single: true, playlist: true }, prompts()),
    ).rejects.toThrow('together');
  });
  it('resolves Spotify track metadata through spotDL without using yt-dlp for Spotify', async () => {
    const runner = new MetadataRunner(() => [
      {
        name: 'Song',
        artists: ['Artist'],
        album_name: 'Album',
        song_id: '1234567890123456789012',
        url: 'https://open.spotify.com/track/1234567890123456789012',
        cover_url: 'https://i.scdn.co/image/test',
        isrc: 'TEST123',
      },
    ]);
    const result = await new Resolver(runner, tools).resolve(
      'https://open.spotify.com/track/1234567890123456789012?si=secret',
    );
    expect(result.kind).toBe('track');
    if (result.kind !== 'track') throw new Error('Expected track');
    expect(result.track.album).toBe('Album');
    expect(result.track.isrc).toBe('TEST123');
    expect(runner.calls[0]?.slice(0, 1)).toEqual(['save']);
    expect(runner.calls[0]).toContain('--save-file');
  });
  it('recognizes a one-song Spotify album as a collection', async () => {
    const runner = new MetadataRunner(() => [
      {
        name: 'Song',
        artists: ['Artist'],
        album_name: 'Release',
        url: 'https://open.spotify.com/track/1234567890123456789012',
      },
    ]);
    const result = await new Resolver(runner, tools).resolve(
      'https://open.spotify.com/album/abcdefghijklmnopqrstuv',
    );
    expect(result.kind).toBe('collection');
    if (result.kind === 'collection') expect(result.collection.title).toBe('Release');
  });
  it('does not guess a downloadable identity from invalid metadata', async () => {
    const resolver = new Resolver(new MetadataRunner(() => ({ title: 'Missing id' })), tools);
    await expect(resolver.resolve('https://youtube.com/watch?v=abcdefghijk')).rejects.toThrow(
      'metadata',
    );
  });
});

describe('input safety', () => {
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.org/a',
    '--exec=touch',
    'http://127.0.0.1/a',
    'http://169.254.169.254/a',
  ])('rejects unsafe input %s', (input) => expect(() => validateUrl(input)).toThrow());
  it('retains Unicode while removing traversal and terminal control characters', () => {
    expect(safeSegment('../Đêm\u001b[31m: sao/CON')).not.toMatch(/[\u001b/:]/);
    expect(safeSegment('Đêm nhạc')).toBe('Đêm nhạc');
    expect(safeSegment('CON')).not.toBe('CON');
  });
});
