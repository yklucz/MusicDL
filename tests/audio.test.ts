import { describe, expect, it } from 'vitest';
import { conversionArgs, filenameFor } from '../src/audio/processor.js';
import { publishExclusive } from '../src/core/safety.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Track } from '../src/core/types.js';
const track: Track = {
  key: 'test',
  id: 'test',
  provider: 'ytdlp',
  url: 'https://example.org/a.wav',
  title: 'Bài hát',
  artist: '../Nghệ sĩ',
  album: 'Album',
  confidence: 'provider',
};
describe('audio contracts', () => {
  it('encodes MP3 with LAME VBR quality 2 and ID3v2.3', () => {
    const args = conversionArgs(
      'source.wav',
      'output.mp3',
      'mp3',
      { codec: 'pcm_s16le', duration: 1, bitrate: 1411, tags: {}, hasArtwork: false },
      track,
    );
    expect(args).toContain('libmp3lame');
    expect(args.slice(args.indexOf('-q:a'), args.indexOf('-q:a') + 2)).toEqual(['-q:a', '2']);
    expect(args.slice(args.indexOf('-id3v2_version'), args.indexOf('-id3v2_version') + 2)).toEqual([
      '-id3v2_version',
      '3',
    ]);
  });
  it('refuses lossy audio converted to FLAC', () => {
    expect(() =>
      conversionArgs(
        'source.webm',
        'output.flac',
        'flac',
        { codec: 'opus', duration: 1, bitrate: 160, tags: {}, hasArtwork: false },
        track,
      ),
    ).toThrow('lossless');
  });
  it('copies AAC and Opus into compatible containers instead of transcoding', () => {
    for (const [format, codec] of [
      ['m4a', 'aac'],
      ['opus', 'opus'],
    ] as const) {
      const args = conversionArgs(
        'input',
        `output.${format}`,
        format,
        { codec, duration: 1, bitrate: 160, tags: {}, hasArtwork: false },
        track,
      );
      expect(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2)).toEqual(['-c:a', 'copy']);
    }
  });
  it('renders Unicode templates without allowing paths to escape', () => {
    const filename = filenameFor(track, 'mp3', '{title} - {artist}');
    expect(filename).toBe('Bài hát - _Nghệ sĩ.mp3');
    expect(() => filenameFor(track, 'mp3', '../../{title}')).toThrow('template');
    expect(() => filenameFor(track, 'mp3', '{unknown}')).toThrow('template');
  });
  it('publishes exclusively even if the destination appears after validation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'musicdl-publish-'));
    const source = path.join(dir, 'source'),
      target = path.join(dir, 'target');
    await writeFile(source, 'new');
    await writeFile(target, 'existing');
    await expect(publishExclusive(source, target)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(target, 'utf8')).toBe('existing');
    expect(await readFile(source, 'utf8')).toBe('new');
  });
});
