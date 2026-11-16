import path from 'node:path';
import { writeFile, stat, readFile, rm } from 'node:fs/promises';
import type { Runner } from '../core/process.js';
import type { AudioFormat, Tools, Track } from '../core/types.js';
import { MusicDLError } from '../core/errors.js';
import { safeSegment, validateUrl } from '../core/safety.js';
import { object, num, parseJson, str } from '../providers/metadata.js';

export interface AudioInfo {
  duration: number;
  codec: string;
  bitrate: number;
  tags: Record<string, string>;
  hasArtwork: boolean;
}
export interface ProcessedAudio {
  file: string;
  extension: string;
  info: AudioInfo;
}
export function isLossless(codec: string): boolean {
  return /^(flac|alac|wavpack|ape|shorten|tta|pcm_)/i.test(codec);
}
export function filenameFor(track: Track, extension: string, template: string): string {
  if (/[\\/\u0000-\u001f]/.test(template) || template.includes('..'))
    throw new MusicDLError('Invalid filename template: directories are not allowed.', 'CONFIG');
  const fields: Record<string, string> = {
    title: track.title,
    artist: track.artist ?? 'Unknown Artist',
    album: track.album ?? 'Unknown Album',
    track: String(track.trackNumber ?? 0).padStart(2, '0'),
    id: track.id,
  };
  const rendered = template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    if (!(key in fields))
      throw new MusicDLError(`Unknown filename template field: ${key}`, 'CONFIG');
    return safeSegment(fields[key]!);
  });
  if (!/^[a-zA-Z0-9]{1,8}$/.test(extension))
    throw new MusicDLError('Invalid output extension.', 'FORMAT');
  return `${safeSegment(rendered)}.${extension}`;
}
export function conversionArgs(
  input: string,
  output: string,
  format: AudioFormat,
  info: AudioInfo,
  track: Track,
  artwork?: string,
): string[] {
  if (format === 'flac' && !isLossless(info.codec))
    throw new MusicDLError(
      'FLAC requires a genuine lossless source. Converting lossy audio cannot restore quality.',
      'LOSSY_SOURCE',
    );
  const attachedPicture =
    ['mp3', 'm4a', 'flac'].includes(format) ||
    (format === 'original' && /\.(mp3|m4a|flac|mp4)$/i.test(output));
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', input];
  if (artwork && attachedPicture) args.push('-i', artwork);
  args.push('-map', '0:a:0', '-map_metadata', '0');
  if (artwork && attachedPicture)
    args.push(
      '-map',
      '1:v:0',
      '-c:v',
      'mjpeg',
      '-disposition:v:0',
      'attached_pic',
      '-metadata:s:v',
      'title=Cover',
      '-metadata:s:v',
      'comment=Cover (front)',
    );
  else if (!artwork && info.hasArtwork && attachedPicture)
    args.push('-map', '0:v?', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  else args.push('-vn');
  if (format === 'mp3') {
    // Existing MP3 is remuxed with compatible tags; other sources use LAME VBR q2.
    args.push('-c:a', info.codec === 'mp3' ? 'copy' : 'libmp3lame');
    if (info.codec !== 'mp3') args.push('-q:a', '2');
    args.push('-id3v2_version', '3', '-write_id3v1', '1');
  } else if (format === 'm4a') {
    args.push('-c:a', ['aac', 'alac'].includes(info.codec) ? 'copy' : 'aac');
    if (!['aac', 'alac'].includes(info.codec)) args.push('-b:a', '256k');
    args.push('-movflags', '+faststart');
  } else if (format === 'opus') {
    args.push('-c:a', info.codec === 'opus' ? 'copy' : 'libopus');
    if (info.codec !== 'opus') args.push('-b:a', '160k', '-vbr', 'on');
  } else if (format === 'flac') args.push('-c:a', info.codec === 'flac' ? 'copy' : 'flac');
  else {
    args.push('-c:a', 'copy');
    if (info.codec === 'mp3' && /\.mp3$/i.test(output)) args.push('-id3v2_version', '3');
  }
  const metadata: Record<string, string | number | undefined> = {
    title: track.title,
    artist: track.artist,
    album: track.album,
    album_artist: track.albumArtist,
    date: track.releaseDate,
    track: track.trackNumber,
    disc: track.discNumber,
    genre: track.genre,
    ISRC: track.isrc,
  };
  for (const [key, value] of Object.entries(metadata))
    if (value !== undefined) {
      args.push('-metadata', `${key}=${value}`);
      if (/\.(opus|ogg)$/i.test(output)) args.push('-metadata:s:a:0', `${key}=${value}`);
    }
  args.push(output);
  return args;
}
export class AudioProcessor {
  constructor(
    private readonly runner: Runner,
    private readonly tools: Tools,
    private readonly allowLocal = false,
  ) {}
  async probe(file: string, signal?: AbortSignal): Promise<AudioInfo> {
    const result = await this.runner.run(
      this.tools.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { signal, timeoutMs: 30_000 },
    );
    const data = object(parseJson(result.stdout));
    const streams = Array.isArray(data.streams) ? data.streams.map(object) : [];
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    if (!audio) throw new MusicDLError('No playable audio stream found.', 'INVALID_AUDIO');
    const f = object(data.format),
      tags: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...object(f.tags), ...object(audio.tags) }))
      if (typeof value === 'string') tags[key.toLowerCase()] = value;
    return {
      duration: Number(f.duration ?? audio.duration) || 0,
      codec: str(audio.codec_name) ?? 'unknown',
      bitrate: (Number(audio.bit_rate ?? f.bit_rate) || 0) / 1000,
      tags,
      hasArtwork: streams.some(
        (stream) =>
          stream.codec_type === 'video' && num(object(stream.disposition).attached_pic) === 1,
      ),
    };
  }
  async process(
    source: string,
    staging: string,
    format: AudioFormat,
    track: Track,
    signal?: AbortSignal,
    warn?: (message: string) => void,
  ): Promise<ProcessedAudio> {
    const info = await this.probe(source, signal);
    let extension = format === 'original' ? path.extname(source).slice(1) : format;
    // Raw downloaded WebM carries audio-only streams; remux to an audio container where possible.
    if (format === 'original' && info.codec === 'opus') extension = 'opus';
    if (format === 'original' && info.codec === 'aac') extension = 'm4a';
    if (format === 'original' && info.codec === 'vorbis') extension = 'ogg';
    const file = path.join(staging, `processed.${extension}`);
    let artwork: string | undefined;
    const pictureComment = ['opus', 'ogg'].includes(extension);
    if (track.artworkUrl && (!info.hasArtwork || pictureComment)) {
      try {
        artwork = await this.artwork(track.artworkUrl, staging, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        warn?.('Cover artwork could not be retrieved; audio metadata will still be written.');
      }
    }
    const args = conversionArgs(source, file, format, info, track, artwork);
    if (pictureComment && !artwork && info.hasArtwork) {
      artwork = path.join(staging, 'existing-cover.jpg');
      await rm(artwork, { force: true });
      await this.runner.run(
        this.tools.ffmpeg,
        [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-i',
          source,
          '-map',
          '0:v:0',
          '-vf',
          'scale=512:512:force_original_aspect_ratio=decrease',
          '-frames:v',
          '1',
          '-q:v',
          '8',
          artwork,
        ],
        { signal, timeoutMs: 30_000 },
      );
    }
    if (pictureComment && artwork) {
      const image = await readFile(artwork);
      const probe = await this.runner.run(
        this.tools.ffprobe,
        ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', artwork],
        { signal },
      );
      const data = object(parseJson(probe.stdout));
      const imageInfo = object(Array.isArray(data.streams) ? data.streams[0] : undefined);
      args.splice(
        args.length - 1,
        0,
        '-metadata',
        `METADATA_BLOCK_PICTURE=${pictureBlock(image, num(imageInfo.width) ?? 512, num(imageInfo.height) ?? 512)}`,
      );
    }
    await rm(file, { force: true });
    await this.runner.run(this.tools.ffmpeg, args, { signal, timeoutMs: 30 * 60_000 });
    const output = await this.probe(file, signal);
    if ((await stat(file)).size === 0 || output.duration <= 0)
      throw new MusicDLError('Audio processing produced an empty file.', 'INVALID_AUDIO');
    return { file, extension, info: output };
  }
  private async artwork(url: string, staging: string, signal?: AbortSignal): Promise<string> {
    validateUrl(url, this.allowLocal);
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (
      !response.ok ||
      !response.body ||
      !/^image\//i.test(response.headers.get('content-type') ?? '')
    )
      throw new MusicDLError('Artwork unavailable.', 'ARTWORK');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 10 * 1024 * 1024) {
        await response.body.cancel().catch(() => {});
        throw new MusicDLError('Artwork exceeds 10 MB.', 'ARTWORK');
      }
      chunks.push(chunk);
    }
    const raw = path.join(staging, 'cover.image'),
      file = path.join(staging, 'cover.jpg');
    await writeFile(raw, Buffer.concat(chunks));
    await rm(file, { force: true });
    await this.runner.run(
      this.tools.ffmpeg,
      [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-i',
        raw,
        '-vf',
        'scale=512:512:force_original_aspect_ratio=decrease',
        '-frames:v',
        '1',
        '-q:v',
        '8',
        file,
      ],
      { signal, timeoutMs: 30_000 },
    );
    if ((await stat(file)).size > 90_000)
      throw new MusicDLError('Artwork is too large to embed safely.', 'ARTWORK');
    return file;
  }
}
function pictureBlock(image: Buffer, width: number, height: number): string {
  const mime = Buffer.from('image/jpeg'),
    header = Buffer.alloc(4 + 4 + mime.length + 4 + 4 * 5);
  let offset = 0;
  const put = (value: number): void => {
    header.writeUInt32BE(value, offset);
    offset += 4;
  };
  put(3);
  put(mime.length);
  mime.copy(header, offset);
  offset += mime.length;
  put(0);
  put(width);
  put(height);
  put(24);
  put(0);
  put(image.length);
  return Buffer.concat([header, image]).toString('base64');
}
