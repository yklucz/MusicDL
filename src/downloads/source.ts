import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { Runner } from '../core/process.js';
import type { Job, Progress } from '../core/types.js';
import type { Settings } from '../settings.js';
import { MusicDLError } from '../core/errors.js';
import { contained, redact } from '../core/safety.js';
import { object, num } from '../providers/metadata.js';
import { ytDownloadArgs } from '../providers/ytdlp.js';
import { Resolver } from '../resolver.js';
import type { AudioProcessor, ProcessedAudio } from '../audio/processor.js';

export function parseProgress(line: string): Progress | undefined {
  const marker = line.indexOf('MUSICDL_PROGRESS ');
  if (marker < 0) return undefined;
  try {
    const d = object(JSON.parse(line.slice(marker + 'MUSICDL_PROGRESS '.length)) as unknown);
    const downloaded = num(d.downloaded_bytes),
      total = num(d.total_bytes) ?? num(d.total_bytes_estimate);
    return {
      stage: 'downloading',
      percent:
        total && downloaded !== undefined
          ? Math.max(0, Math.min(100, (downloaded / total) * 100))
          : undefined,
      speed: num(d.speed),
      eta: num(d.eta),
    };
  } catch {
    return undefined;
  }
}
export function createPipeline(
  runner: Runner,
  config: Settings,
  processor: AudioProcessor,
): (
  job: Job,
  staging: string,
  signal: AbortSignal,
  update: (progress: Progress) => void,
) => Promise<ProcessedAudio> {
  return async (job, staging, signal, update) => {
    const track = job.track;
    let providerOutput = '';
    if (track.provider === 'spotify' && job.format === 'flac')
      throw new MusicDLError(
        'Spotify matching uses lossy YouTube sources. Choose MP3, M4A, Opus or original instead of FLAC.',
        'LOSSY_SOURCE',
      );
    if (track.provider !== 'spotify' && track.confidence !== 'manual') {
      const resolved = await new Resolver(runner, config.tools, config.allowLocalUrls).resolve(
        track.url,
        signal,
      );
      if (resolved.kind !== 'track')
        throw new MusicDLError(
          'A selected track unexpectedly resolved to a collection. Paste an individual track URL.',
          'SELECTION',
        );
      // Fill missing release details without changing the selected identity or explicit corrections.
      Object.assign(track, {
        ...track,
        ...resolved.track,
        key: track.key,
        url: track.url,
        album: track.album ?? resolved.track.album,
        trackNumber: track.trackNumber ?? resolved.track.trackNumber,
      });
    }
    if (track.provider === 'spotify') {
      update({ stage: 'matching audio with spotDL' });
      const sourceFormat = job.format === 'm4a' ? 'm4a' : 'opus';
      const result = await runner.run(
        config.tools.spotdl,
        [
          'download',
          track.url,
          '--format',
          sourceFormat,
          '--bitrate',
          'disable',
          '--output',
          path.join(staging, 'source.{output-ext}'),
          '--threads',
          '1',
          '--overwrite',
          'skip',
          '--ffmpeg',
          config.tools.ffmpeg,
          '--lyrics',
          '--log-level',
          'INFO',
          '--simple-tui',
          '--max-retries',
          '1',
        ],
        {
          signal,
          cwd: staging,
          timeoutMs: 30 * 60_000,
          onLine: (line) => {
            const match = line.match(/(?:^|\s)(\d{1,3}(?:\.\d+)?)%/);
            if (match)
              update({
                stage: 'downloading matched audio',
                percent: Math.min(100, Number(match[1])),
              });
          },
        },
      );
      providerOutput = `${result.stderr}\n${result.stdout}`;
    } else {
      await runner.run(
        config.tools.ytdlp,
        ytDownloadArgs(track, path.join(staging, 'source.%(ext)s'), job.format === 'flac'),
        {
          signal,
          timeoutMs: 60 * 60_000,
          onLine: (line) => {
            const progress = parseProgress(line);
            if (progress) update(progress);
          },
        },
      );
    }
    signal.throwIfAborted();
    const sources = (await readdir(staging)).filter(
      (name) =>
        /^source\.[a-zA-Z0-9]{1,8}$/.test(name) && !/\.(part|ytdl|json|jpg|png|webp)$/i.test(name),
    );
    if (sources.length !== 1)
      throw new MusicDLError(
        `The downloader did not produce exactly one audio file. No file was published.${providerOutput.trim() ? ` Provider: ${redact(providerOutput).slice(-1500)}` : ''}`,
        'INVALID_AUDIO',
        /timeout|timed out|connection|network|429|502|503|504/i.test(providerOutput),
      );
    const source = path.join(staging, sources[0]!);
    if (!contained(staging, source) || !(await stat(source)).isFile())
      throw new MusicDLError('Invalid downloaded file.', 'UNSAFE_PATH');
    update({ stage: 'processing' });
    return processor.process(source, staging, job.format, track, signal, (warning) =>
      update({ stage: warning }),
    );
  };
}
