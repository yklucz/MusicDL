import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { MusicDL } from './app.js';
import type { DownloadFlags } from './app.js';
import { MusicDLError, errorMessage, isAbort } from './core/errors.js';
import { cleanText, expandPath, redact } from './core/safety.js';
import { ClackPrompts } from './ui/clack-prompts.js';
import { doctor } from './doctor.js';
import { executeExport, planExport } from './devices/export.js';
import type { Job } from './core/types.js';

function print(value: string): void {
  process.stdout.write(`${value.split('\n').map(cleanText).join('\n')}\n`);
}
function json(value: unknown): void {
  print(
    JSON.stringify(
      value,
      (_key, item: unknown) => (typeof item === 'string' ? redact(item) : item),
      2,
    ),
  );
}
function formatOption(): Option {
  return new Option('-f, --format <format>', 'Output audio format').choices([
    'mp3',
    'm4a',
    'opus',
    'flac',
    'original',
  ]);
}
function downloadOptions(command: Command): Command {
  return command
    .option('--single', 'Only the selected video; never expand to its playlist')
    .option('--playlist', 'Explicitly select all available collection tracks')
    .option('-y, --yes', 'Approve the displayed batch count without prompting')
    .addOption(formatOption())
    .option('--queue-only', 'Persist the selection without starting a worker')
    .option('--local-playlist [name]', 'Create an ordered local M3U8 after download')
    .option('--edit-metadata', 'Correct title, artist and album before downloading');
}
async function withApp(
  action: (app: MusicDL, prompt: ClackPrompts) => Promise<void>,
): Promise<void> {
  const app = await MusicDL.open(),
    prompt = new ClackPrompts();
  const interrupt = (): void => {
    app.operations.abort();
    void app.manager.stop();
    process.exitCode = 130;
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await action(app, prompt);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await app.close();
  }
}
async function runQueue(app: MusicDL): Promise<void> {
  const processed = new Set(
    app.store
      .jobs()
      .filter((job) => ['queued', 'retrying', 'downloading', 'processing'].includes(job.status))
      .map((job) => job.id),
  );
  const started = (id: string): void => {
    processed.add(id);
  };
  app.manager.on('job-start', started);
  const report = (): void => {
    const jobs = app.store.jobs(),
      active = jobs.filter((job) => ['downloading', 'processing'].includes(job.status));
    if (process.stderr.isTTY && active.length) {
      const line = active
        .map(
          (job) =>
            `${job.track.title.slice(0, 28)} ${job.progress?.percent?.toFixed(0) ?? '…'}%${job.progress?.speed ? ` ${(job.progress.speed / 1024 / 1024).toFixed(1)} MB/s` : ''}${job.progress?.eta !== undefined ? ` ETA ${Math.ceil(job.progress.eta)}s` : ''}`,
        )
        .join(' · ');
      process.stderr.write(`\r\x1b[2K${cleanText(line)}`);
    }
  };
  await app.manager.start();
  const timer = setInterval(report, 500);
  try {
    await app.manager.drain(app.operations.signal);
  } finally {
    clearInterval(timer);
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
    await app.manager.stop();
    app.manager.off('job-start', started);
  }
  const jobs = app.store.jobs().filter((job) => processed.has(job.id));
  for (const job of jobs.filter((job) => ['completed', 'failed'].includes(job.status)))
    print(
      `${job.status === 'completed' ? '✓' : '✗'} ${job.track.title}${job.outputPath && job.status === 'completed' ? ` → ${job.outputPath}` : ''}${job.status === 'failed' ? `: ${job.error ?? 'Unknown error'}` : ''}`,
    );
  for (const batch of app.store.downloadPlaylists())
    if (batch.error) print(`Playlist ${batch.name}: ${batch.error}`);
  if (jobs.some((job) => job.status === 'failed')) process.exitCode = 1;
}
function findJob(app: MusicDL, id: string): Job {
  const matches = app.store.jobs().filter((job) => job.id === id || job.id.startsWith(id));
  if (matches.length !== 1)
    throw new MusicDLError(
      matches.length ? 'Job ID prefix is ambiguous.' : 'Queue job not found.',
      'NOT_FOUND',
    );
  return matches[0]!;
}
async function download(
  app: MusicDL,
  prompts: ClackPrompts,
  input: string,
  options: DownloadFlags & { queueOnly?: boolean },
): Promise<void> {
  const selected = await app.downloadInput(input, options, prompts);
  if (!options.queueOnly && selected.added) await runQueue(app);
  else if (options.queueOnly)
    print('Saved. Run musicdl or musicdl queue run to process the queue.');
}
export function createProgram(): Command {
  const program = new Command()
    .name('musicdl')
    .description(
      'Universal music downloader and independent library manager. Download only content you are authorized to save.',
    )
    .version('1.0.0');
  downloadOptions(program)
    .argument('[input...]', 'URL(s), or a song title and artist')
    .action(async (input: string[], options: DownloadFlags & { queueOnly?: boolean }) => {
      await withApp(async (app, prompt) => {
        if (input.length) await download(app, prompt, input.join(' '), options);
        else if (prompt.interactive) {
          const { launchDashboard } = await import('./ui/dashboard.js');
          await launchDashboard(app);
        } else {
          program.outputHelp();
        }
      });
    });
  downloadOptions(
    program
      .command('download')
      .description('Automatically resolve URL(s), preview collections, and download selected audio')
      .argument('<urls...>'),
  ).action(
    async (urls: string[], _options: DownloadFlags & { queueOnly?: boolean }, command: Command) =>
      withApp((app, prompt) =>
        download(
          app,
          prompt,
          urls.join(' '),
          command.optsWithGlobals<DownloadFlags & { queueOnly?: boolean }>(),
        ),
      ),
  );
  program
    .command('resolve')
    .description('Inspect provider metadata without downloading')
    .argument('<url>')
    .action(async (url: string) =>
      withApp(async (app, prompt) => {
        json(
          await app.resolver.resolve(url, app.operations.signal, (value) => prompt.progress(value)),
        );
      }),
    );
  program
    .command('search')
    .description('Search YouTube by song title and artist')
    .argument('<query...>')
    .option('--json', 'Machine-readable results')
    .option('--download', 'Select search results to download')
    .action(async (query: string[], options: { json?: boolean; download?: boolean }) =>
      withApp(async (app, prompt) => {
        if (options.download) await download(app, prompt, query.join(' '), {});
        else {
          const tracks = await app.resolver.search(query.join(' '), app.operations.signal);
          if (options.json) json(tracks);
          else
            for (const [i, track] of tracks.entries())
              print(
                `${i + 1}. ${track.title}${track.artist ? ` — ${track.artist}` : ''}\n   ${track.url}`,
              );
        }
      }),
    );
  const queue = program
    .command('queue')
    .description('Show and manage the persistent download queue')
    .option('--json', 'Machine-readable queue');
  queue.action(async (options: { json?: boolean }) =>
    withApp(async (app) => {
      const jobs = app.store.jobs();
      if (options.json) json(jobs);
      else {
        if (!jobs.length) print('Queue is empty.');
        for (const job of jobs)
          print(
            `${job.id.slice(0, 8)}  ${job.status.padEnd(11)} ${job.track.title}${job.error ? ` · ${job.error}` : ''}`,
          );
      }
    }),
  );
  queue
    .command('run')
    .description('Resume pending and interrupted downloads')
    .action(async () => withApp(runQueue));
  queue
    .command('cancel')
    .argument('<id>')
    .description('Cancel a job (ID or unique prefix)')
    .action(async (id: string) =>
      withApp(async (app) => {
        const job = findJob(app, id);
        await app.manager.cancel(job.id);
        print(`Cancellation requested: ${job.track.title}`);
      }),
    );
  queue
    .command('retry')
    .argument('<id>')
    .option('--queue-only', 'Queue without downloading')
    .description('Retry a failed or cancelled job')
    .action(async (id: string, options: { queueOnly?: boolean }) =>
      withApp(async (app) => {
        app.manager.retry(findJob(app, id).id);
        if (!options.queueOnly) await runQueue(app);
      }),
    );
  const library = program
    .command('library')
    .description('Browse, import, inspect and organize your music')
    .argument('[query...]')
    .option('--json', 'Machine-readable tracks');
  library.action(async (query: string[], options: { json?: boolean }) =>
    withApp(async (app) => {
      const tracks = app.store.library(query.join(' '));
      if (options.json) json(tracks);
      else {
        print(`${tracks.length} indexed tracks`);
        for (const track of tracks)
          print(
            `${track.id.slice(0, 8)}  ${track.title} — ${track.artist} · ${track.codec} · ${track.bitrate.toFixed(0)} kb/s\n          ${track.path}`,
          );
      }
    }),
  );
  library
    .command('scan')
    .argument('[directories...]')
    .description('Index configured library roots and downloads, without altering files')
    .action(async (directories: string[]) =>
      withApp(async (app, prompt) => {
        for (const location of directories.length
          ? directories
          : [...app.config.libraryDirs, app.config.downloadsDir]) {
          try {
            const result = await app.library.import(location, { signal: app.operations.signal });
            prompt.note(
              `${location}: indexed ${result.tracks.length}; ${result.errors.length} skipped/errors.`,
            );
            for (const error of result.errors) print(redact(error));
          } catch (e) {
            print(`${location}: ${redact(errorMessage(e))}`);
            process.exitCode = 1;
          }
        }
      }),
    );
  library
    .command('import')
    .argument('<location>')
    .option('--copy', 'Copy audio into the first configured library directory; never overwrite')
    .description('Index an existing directory or audio file')
    .action(async (location: string, options: { copy?: boolean }) =>
      withApp(async (app, prompt) => {
        const result = await app.library.import(location, {
          copyTo: options.copy ? app.config.libraryDirs[0] : undefined,
          signal: app.operations.signal,
        });
        prompt.note(
          `Indexed ${result.tracks.length} tracks. ${result.errors.length} skipped/errors.`,
        );
        for (const error of result.errors) print(redact(error));
        if (result.errors.length) process.exitCode = 1;
      }),
    );
  library
    .command('inspect')
    .argument('<id-or-path>')
    .description('Inspect actual audio metadata with ffprobe')
    .action(async (id: string) =>
      withApp(async (app) => {
        const matches = app.store
          .library()
          .filter((track) => track.id === id || track.id.startsWith(id));
        const file = matches.length === 1 ? matches[0]!.path : expandPath(id);
        json(await app.audio.probe(file, app.operations.signal));
      }),
    );
  library
    .command('convert')
    .argument('<id>')
    .addOption(formatOption().makeOptionMandatory())
    .requiredOption('--output <directory>', 'Directory for the converted copy')
    .description('Convert a local copy using the same quality and metadata pipeline')
    .action(
      async (
        id: string,
        options: { format: import('./core/types.js').AudioFormat; output: string },
      ) =>
        withApp(async (app) => {
          const matches = app.store
            .library()
            .filter((track) => track.id === id || track.id.startsWith(id));
          if (matches.length !== 1)
            throw new MusicDLError('Use a unique library track ID.', 'NOT_FOUND');
          json(
            await app.library.convert(
              matches[0]!.id,
              options.format,
              options.output,
              app.operations.signal,
            ),
          );
        }),
    );
  library
    .command('duplicates')
    .description('Find identical indexed audio files by SHA-256')
    .action(async () =>
      withApp(async (app) => {
        json(app.store.duplicateGroups());
      }),
    );
  library
    .command('missing')
    .description('List indexed files that are no longer present')
    .action(async () =>
      withApp(async (app) => {
        json(await app.library.missing());
      }),
    );
  library
    .command('edit')
    .argument('<id>')
    .option('--title <title>')
    .option('--artist <artist>')
    .option('--album <album>')
    .option('--write-tags', 'Also rewrite audio tags, keeping an original backup')
    .option('-y, --yes', 'Approve the displayed file update')
    .description('Correct metadata in the index; optionally write tags after approval')
    .action(
      async (
        id: string,
        options: {
          title?: string;
          artist?: string;
          album?: string;
          writeTags?: boolean;
          yes?: boolean;
        },
      ) =>
        withApp(async (app, prompt) => {
          const matches = app.store
            .library()
            .filter((track) => track.id === id || track.id.startsWith(id));
          if (matches.length !== 1)
            throw new MusicDLError('Use a unique library track ID.', 'NOT_FOUND');
          const track = matches[0]!;
          print(
            `Update ${track.title}: ${JSON.stringify({ title: options.title, artist: options.artist, album: options.album })}${options.writeTags ? `\nWrite tags: ${track.path}\nAn original backup will be retained beside the file.` : '\nChanges apply to the library index.'}`,
          );
          if (
            options.writeTags &&
            !options.yes &&
            (!prompt.interactive ||
              !(await prompt.confirm('Write these tags to the audio file?', false)))
          )
            return;
          json(await app.library.correct(track.id, options, options.writeTags));
        }),
    );
  library
    .command('organize')
    .argument('<destination>')
    .addOption(
      new Option('--structure <structure>')
        .choices(['flat', 'artist-album'])
        .default('artist-album'),
    )
    .option('--apply', 'Apply the displayed move plan')
    .description('Preview organization; files move only with --apply or interactive approval')
    .action(
      async (
        destination: string,
        options: { structure: 'flat' | 'artist-album'; apply?: boolean },
      ) =>
        withApp(async (app, prompt) => {
          const root = expandPath(destination),
            plan = app.library.planOrganization(app.store.library(), root, options.structure);
          json(plan);
          print(`${plan.length} files would move.`);
          if (!plan.length) return;
          if (
            options.apply ||
            (prompt.interactive &&
              (await prompt.confirm('Apply this file organization plan?', false)))
          ) {
            await app.library.organize(plan, root);
            print(`Organized ${plan.length} files.`);
          } else print('Preview only. Use --apply to execute this plan.');
        }),
    );
  library
    .command('export')
    .argument('<file>')
    .description('Export the library index as JSON without replacing existing files')
    .action(async (file: string) =>
      withApp(async (app) => {
        await app.library.exportManifest(file);
        print(`Exported ${expandPath(file)}`);
      }),
    );
  const playlists = program
    .command('playlists')
    .description('Create, edit, import and export ordered local playlists');
  playlists.action(async () =>
    withApp(async (app) => {
      for (const playlist of app.store.playlists())
        print(
          `${playlist.id.slice(0, 8)}  ${playlist.name} · ${app.store.playlistTracks(playlist.id).length} tracks`,
        );
      if (!app.store.playlists().length)
        print('No playlists. Use musicdl playlists create <name>.');
    }),
  );
  const playlistId = (app: MusicDL, input: string): string => {
    const matches = app.store.playlists().filter((p) => p.id.startsWith(input) || p.name === input);
    if (matches.length !== 1)
      throw new MusicDLError('Use a unique playlist ID or name.', 'NOT_FOUND');
    return matches[0]!.id;
  };
  playlists
    .command('create')
    .argument('<name>')
    .action(async (name: string) =>
      withApp(async (app) => {
        json(app.playlists.create(name));
      }),
    );
  playlists
    .command('show')
    .argument('<playlist>')
    .action(async (input: string) =>
      withApp(async (app) => {
        json(app.store.playlistTracks(playlistId(app, input)));
      }),
    );
  playlists
    .command('rename')
    .argument('<playlist>')
    .argument('<name>')
    .action(async (input: string, name: string) =>
      withApp(async (app) => {
        app.playlists.rename(playlistId(app, input), name);
        print('Playlist renamed.');
      }),
    );
  playlists
    .command('delete')
    .argument('<playlist>')
    .option('-y, --yes', 'Approve deletion of this playlist record')
    .action(async (input: string, options: { yes?: boolean }) =>
      withApp(async (app, prompt) => {
        const id = playlistId(app, input);
        if (
          options.yes ||
          (prompt.interactive &&
            (await prompt.confirm('Delete this playlist? Audio files are retained.', false)))
        ) {
          app.playlists.delete(id);
          print('Playlist deleted.');
        } else print('No change. Use --yes to confirm deletion.');
      }),
    );
  for (const action of ['add', 'remove', 'reorder'] as const)
    playlists
      .command(action)
      .argument('<playlist>')
      .argument('<track-ids...>')
      .description(`${action} tracks by library ID; reorder requires all current IDs`)
      .action(async (input: string, ids: string[]) =>
        withApp(async (app) => {
          const full = ids.map((id) => {
            const matches = app.store
              .library()
              .filter((track) => track.id === id || track.id.startsWith(id));
            if (matches.length !== 1)
              throw new MusicDLError(`Track ID is missing or ambiguous: ${id}`, 'NOT_FOUND');
            return matches[0]!.id;
          });
          app.playlists[action](playlistId(app, input), full);
          print('Playlist updated.');
        }),
      );
  playlists
    .command('import')
    .argument('<file>')
    .option('--name <name>', 'Playlist name')
    .action(async (file: string, options: { name?: string }) =>
      withApp(async (app) => {
        json(
          await app.playlists.import(
            file,
            options.name ?? path.basename(file, path.extname(file)),
            app.library,
          ),
        );
      }),
    );
  playlists
    .command('export')
    .argument('<playlist>')
    .argument('<file>')
    .option('--absolute', 'Use absolute paths instead of relative paths')
    .action(async (input: string, file: string, options: { absolute?: boolean }) =>
      withApp(async (app) => {
        await app.playlists.export(playlistId(app, input), file, !options.absolute);
        print(`Exported ${expandPath(file)}`);
      }),
    );
  program
    .command('export')
    .argument('<destination>')
    .description('Preview or execute a music/device export; never modifies source audio')
    .addOption(new Option('--device <device>').choices(['folder', 'canary3ds']).default('folder'))
    .option('--playlist <name-or-id>', 'Export only this playlist, preserving order')
    .option('-y, --yes', 'Approve the displayed copy plan')
    .action(
      async (
        destination: string,
        options: { device: 'folder' | 'canary3ds'; playlist?: string; yes?: boolean },
      ) =>
        withApp(async (app, prompt) => {
          const id = options.playlist ? playlistId(app, options.playlist) : undefined;
          const tracks = id ? app.store.playlistTracks(id) : app.store.library();
          if (!tracks.length) throw new MusicDLError('No tracks selected for export.', 'SELECTION');
          const plan = planExport(tracks, destination, {
            kind: options.device,
            playlistName: id ? app.playlists.require(id).name : 'MusicDL',
          });
          json({ files: plan.entries, playlist: plan.playlistPath, count: tracks.length });
          if (
            options.yes ||
            (prompt.interactive &&
              (await prompt.confirm(`Copy ${tracks.length} tracks using this export plan?`, false)))
          ) {
            await executeExport(plan);
            print('Export completed. Audio and embedded artwork were copied.');
          } else print('Preview only. Add --yes to copy these files.');
        }),
    );
  program
    .command('history')
    .description('Show download history')
    .option('--json')
    .action(async (options: { json?: boolean }) =>
      withApp(async (app) => {
        if (options.json) json(app.store.history());
        else
          for (const entry of app.store.history())
            print(
              `${new Date(entry.createdAt).toLocaleString()}  ${entry.status.padEnd(10)} ${entry.title}${entry.message ? ` · ${entry.message}` : ''}`,
            );
      }),
    );
  const config = program.command('config').description('Show and manage settings');
  config.action(async () =>
    withApp(async (app) => {
      json(app.config);
      print(`Configuration: ${app.paths.settings}`);
    }),
  );
  config.command('path').action(async () =>
    withApp(async (app) => {
      print(app.paths.settings);
    }),
  );
  config
    .command('set')
    .argument('<key>')
    .argument('<value>')
    .description(
      'Set a setting; arrays/objects/booleans/numbers use JSON; tools.spotdl is supported',
    )
    .action(async (key: string, value: string) =>
      withApp(async (app) => {
        const parsed: unknown = (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return value;
          }
        })();
        if (key.startsWith('tools.')) {
          const tool = key.slice(6);
          if (
            !['ytdlp', 'spotdl', 'ffmpeg', 'ffprobe'].includes(tool) ||
            typeof parsed !== 'string'
          )
            throw new MusicDLError(
              'Use tools.ytdlp, tools.spotdl, tools.ffmpeg or tools.ffprobe with an executable path.',
              'CONFIG',
            );
          await app.updateConfig({ tools: { ...app.config.tools, [tool]: parsed } });
        } else {
          if (!(key in app.config) || key === '__proto__')
            throw new MusicDLError('Unknown setting.', 'CONFIG');
          await app.updateConfig({ [key]: parsed });
        }
        print('Settings saved.');
      }),
    );
  program
    .command('doctor')
    .description('Check tool versions, supported options, and audio encoders')
    .option('--json')
    .action(async (options: { json?: boolean }) =>
      withApp(async (app) => {
        const result = await doctor(app.runner, app.config);
        if (options.json) json(result);
        else {
          print(
            `MusicDL 1.0.0 · Node ${process.versions.node} · ${process.platform}/${process.arch}`,
          );
          for (const item of result) print(`${item.ok ? '✓' : '✗'} ${item.name}: ${item.detail}`);
          print(`State: ${app.paths.state}`);
          print(
            result.every((item) => item.ok)
              ? 'All required tools and encoders are available.'
              : 'Missing tools: pnpm setup:tools (yt-dlp/spotDL), and install FFmpeg with your platform package manager.',
          );
        }
        if (result.some((item) => !item.ok)) process.exitCode = 1;
      }),
    );
  program.addHelpText(
    'after',
    '\nExamples:\n  musicdl "https://www.youtube.com/watch?v=VIDEO_ID&list=PLAYLIST_ID"\n  musicdl download "URL" --single\n  musicdl download "PLAYLIST_URL" --playlist --yes --local-playlist\n  musicdl library import ~/Music\n  musicdl export /Volumes/SDCARD --device canary3ds --playlist Favorites\n\nspotDL uses Spotify metadata and generally matches audio from YouTube.\nQuote URLs containing & in your shell. No DRM or authentication restrictions are bypassed.',
  );
  return program;
}
export async function main(argv = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    if (isAbort(error) || (error instanceof Error && error.name === 'AbortError')) {
      process.exitCode = 130;
      return;
    }
    process.stderr.write(`MusicDL: ${redact(errorMessage(error))}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main();
