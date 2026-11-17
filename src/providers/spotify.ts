import { mkdtemp, lstat, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Runner } from '../core/process.js';
import type { ResolvedInput, Tools } from '../core/types.js';
import { abortError, errorMessage, isAbort, MusicDLError } from '../core/errors.js';
import { redact } from '../core/safety.js';
import { parseJson, spotifyMetadata, spotifyPlaylistBatch } from './metadata.js';

export type SpotifyKind = 'track' | 'album' | 'playlist';
export interface MetadataProgress {
  provider: 'spotify';
  kind: SpotifyKind;
  stage: 'starting' | 'loading' | 'validating' | 'complete' | 'failed' | 'cancelled';
  elapsedMs: number;
  message: string;
  reportedTracks?: number | undefined;
  receivedTracks?: number | undefined;
}
export type MetadataReporter = (progress: MetadataProgress | undefined) => void;
export function metadataStatus(progress: MetadataProgress): string {
  return `Spotify ${progress.kind} · ${progress.message} · ${(progress.elapsedMs / 1000).toFixed(0)}s elapsed${progress.reportedTracks === undefined ? '' : progress.receivedTracks === undefined ? ` · ${progress.reportedTracks} tracks reported` : ` · ${progress.receivedTracks}/${progress.reportedTracks} entries received`}`;
}

async function companionPython(command: string): Promise<string | undefined> {
  const extensions =
    process.platform === 'win32' && !path.extname(command)
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : [''];
  const candidates =
    path.isAbsolute(command) || /[\\/]/.test(command)
      ? [path.resolve(command)]
      : (process.env.PATH ?? '')
          .split(path.delimiter)
          .flatMap((directory) =>
            extensions.map((extension) => path.join(directory, command + extension)),
          );
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate);
      const python = path.join(
        path.dirname(executable),
        process.platform === 'win32' ? 'python.exe' : 'python',
      );
      const info = await lstat(python);
      if (info.isFile() || info.isSymbolicLink()) return python;
    } catch {
      /* Try the next executable location. */
    }
  }
  return undefined;
}

// spotDL 4.6 save is not a streaming JSON API. Keep diagnostics on its console,
// read metadata from a private temporary file, and never turn partial JSON into a collection.
export async function loadSpotifyMetadata(
  runner: Runner,
  tools: Tools,
  url: string,
  kind: SpotifyKind,
  signal?: AbortSignal,
  report?: MetadataReporter,
  timeoutMs = 240_000,
): Promise<ResolvedInput> {
  signal?.throwIfAborted();
  const started = performance.now();
  let directory: string | undefined;
  let reportedTracks: number | undefined;
  let receivedTracks: number | undefined;
  let stage: MetadataProgress['stage'] = 'starting';
  let message = 'Starting spotDL';
  let incomplete = false;
  const diagnostics: string[] = [];
  const update = (): void =>
    report?.({
      provider: 'spotify',
      kind,
      stage,
      elapsedMs: performance.now() - started,
      message,
      reportedTracks,
      receivedTracks,
    });
  const activity = (line: string): void => {
    const safe = redact(line).trim();
    if (safe) {
      diagnostics.push(safe.slice(-300));
      if (diagnostics.length > 8) diagnostics.shift();
    }
    const count = safe.match(/Found\s+(\d+)\s+songs?\b/i);
    const page = safe.match(/MUSICDL_META PAGE (\d+)\/(\d+)/);
    if (page) {
      receivedTracks = Number(page[1]);
      reportedTracks = Number(page[2]);
      message = 'Reading playlist pages';
    }
    if (count) {
      const nextCount = Number(count[1]);
      if (reportedTracks !== undefined && nextCount !== reportedTracks) incomplete = true;
      reportedTracks = nextCount;
      message = 'Resolving track details with spotDL';
    } else if (/Processing query/i.test(safe)) message = 'Requesting Spotify metadata';
    if (
      /MUSICDL_META\s+ERROR|generated an exception|Skipping track:|could not get metadata/i.test(
        safe,
      )
    )
      incomplete = true;
    stage = 'loading';
    update();
  };
  update();
  const timer = setInterval(update, 500);
  timer.unref();
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'musicdl-metadata-'));
    const output = path.join(directory, 'metadata.spotdl');
    stage = 'loading';
    message = 'Waiting for Spotify / spotDL';
    update();
    const python = kind === 'playlist' ? await companionPython(tools.spotdl) : undefined;
    if (kind === 'playlist' && !python)
      throw new MusicDLError(
        'Reliable playlist metadata requires the spotDL Python environment. Run pnpm setup:tools and configure tools.spotdl to its executable, then restart MusicDL. The save CLI alone cannot verify complete playlist pagination.',
        'TOOL_MISSING',
      );
    const args = python
      ? [
          '-u',
          fileURLToPath(new URL('../../scripts/spotify-playlist.py', import.meta.url)),
          url,
          '--output',
          output,
        ]
      : [
          'save',
          url,
          '--save-file',
          output,
          // Avoid the CLI's unrelated YouTube Music connectivity probe and lyric requests.
          '--audio',
          'youtube',
          '--lyrics',
          '--threads',
          '4',
          '--max-retries',
          '2',
          '--ffmpeg',
          tools.ffmpeg,
          '--log-level',
          'INFO',
          '--simple-tui',
          '--log-format',
          'MUSICDL_META %(levelname)s %(message)s',
        ];
    const result = await runner.run(python ?? tools.spotdl, args, {
      signal,
      timeoutMs,
      maxOutput: 2 * 1024 * 1024,
      onLine: activity,
    });
    signal?.throwIfAborted();
    // Also inspect the final captured tail in case a provider omits a trailing newline.
    for (const line of `${result.stdout}\n${result.stderr}`.split(/[\r\n]+/))
      if (/ERROR|generated an exception|Skipping track:/i.test(line)) activity(line);
    stage = 'validating';
    message = 'Checking metadata, counts and source order';
    update();
    if (incomplete)
      throw new MusicDLError(
        'Incomplete metadata: spotDL reported failed or skipped tracks. Retry the collection; no audio was queued.',
        'INCOMPLETE_METADATA',
      );
    let size: number;
    try {
      const info = await lstat(output);
      if (!info.isFile() || info.isSymbolicLink())
        throw new MusicDLError('Invalid metadata output file.', 'METADATA');
      size = info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new MusicDLError(
          'spotDL exited without a metadata file. Check the provider diagnostics and retry.',
          'METADATA',
        );
      throw error;
    }
    if (size > 32 * 1024 * 1024)
      throw new MusicDLError(
        'Metadata exceeds 32 MB. Resolve smaller collections separately.',
        'OUTPUT_LIMIT',
      );
    const data = parseJson(await readFile(output, 'utf8'));
    const resolved: ResolvedInput = python
      ? { kind: 'collection', collection: spotifyPlaylistBatch(data, url) }
      : spotifyMetadata(data, kind, url, reportedTracks);
    stage = 'complete';
    message = 'Metadata ready for selection';
    update();
    return resolved;
  } catch (error) {
    const cancelled = signal?.aborted || isAbort(error);
    stage = cancelled ? 'cancelled' : 'failed';
    message = cancelled ? 'Metadata loading cancelled' : 'Metadata loading failed';
    update();
    if (cancelled) throw abortError();
    const code = error instanceof MusicDLError ? error.code : 'METADATA';
    const retryable = error instanceof MusicDLError && error.retryable;
    throw new MusicDLError(
      `Spotify ${kind} metadata failed after ${((performance.now() - started) / 1000).toFixed(1)}s [${code}]: ${redact(errorMessage(error))}${diagnostics.length ? `\nRecent provider activity: ${redact(diagnostics.join('\n')).slice(-1200)}` : ''}`,
      code,
      retryable,
    );
  } finally {
    clearInterval(timer);
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      report?.(undefined);
    }
  }
}
