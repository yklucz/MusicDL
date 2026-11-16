import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { expandPath } from './core/safety.js';
import { MusicDLError } from './core/errors.js';

const format = z.enum(['mp3', 'm4a', 'opus', 'flac', 'original']);
export const settingsSchema = z
  .object({
    downloadsDir: z.string().min(1),
    libraryDirs: z.array(z.string().min(1)).min(1),
    format,
    filenameTemplate: z.string().min(1),
    structure: z.enum(['flat', 'artist-album']),
    concurrency: z.number().int().min(1).max(8),
    maxRetries: z.number().int().min(0).max(10),
    retryBaseMs: z.number().int().min(10).max(60_000),
    largeBatchThreshold: z.number().int().min(2).max(10_000),
    theme: z.enum(['aurora', 'amber', 'mono']),
    createPlaylist: z.boolean(),
    allowLocalUrls: z.boolean(),
    tools: z.object({
      ytdlp: z.string().min(1),
      spotdl: z.string().min(1),
      ffmpeg: z.string().min(1),
      ffprobe: z.string().min(1),
    }),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export interface AppPaths {
  config: string;
  state: string;
  settings: string;
  database: string;
  staging: string;
  lock: string;
}
export function appPaths(): AppPaths {
  const home = homedir();
  const root = process.env.MUSICDL_HOME ? expandPath(process.env.MUSICDL_HOME) : undefined;
  const config =
    root ??
    (process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'MusicDL')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'MusicDL')
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'musicdl'));
  const state =
    root ??
    (process.platform === 'linux'
      ? path.join(process.env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'musicdl')
      : config);
  return {
    config,
    state,
    settings: path.join(config, 'config.json'),
    database: path.join(state, 'musicdl.sqlite'),
    staging: path.join(state, 'staging'),
    lock: path.join(state, 'worker.lock'),
  };
}
export function defaults(home = homedir()): Settings {
  const localSpotdl = fileURLToPath(
    new URL(
      `../.tools/spotdl/${process.platform === 'win32' ? 'Scripts/spotdl.exe' : 'bin/spotdl'}`,
      import.meta.url,
    ),
  );
  const localYtdlp = fileURLToPath(
    new URL(
      `../.tools/spotdl/${process.platform === 'win32' ? 'Scripts/yt-dlp.exe' : 'bin/yt-dlp'}`,
      import.meta.url,
    ),
  );
  return {
    downloadsDir: path.join(home, 'Music', 'MusicDL', 'Downloads'),
    libraryDirs: [path.join(home, 'Music', 'MusicDL', 'Library')],
    format: 'mp3',
    filenameTemplate: '{title} - {artist}',
    structure: 'flat',
    concurrency: 2,
    maxRetries: 3,
    retryBaseMs: 1000,
    largeBatchThreshold: 20,
    theme: 'aurora',
    createPlaylist: false,
    allowLocalUrls: false,
    tools: {
      ytdlp: existsSync(localYtdlp) ? localYtdlp : 'yt-dlp',
      spotdl: existsSync(localSpotdl) ? localSpotdl : 'spotdl',
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
    },
  };
}
export function validateSettings(value: unknown): Settings {
  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success)
    throw new MusicDLError(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      'CONFIG',
    );
  const config = parsed.data;
  if (
    /[\\/\u0000-\u001f]/.test(config.filenameTemplate) ||
    /\.{2}/.test(config.filenameTemplate) ||
    /\{(?!title\}|artist\}|album\}|track\}|id\})[^}]*\}/.test(config.filenameTemplate)
  )
    throw new MusicDLError(
      'Invalid filename template. Use {title}, {artist}, {album}, {track}, {id} without directory separators.',
      'CONFIG',
    );
  return {
    ...config,
    downloadsDir: expandPath(config.downloadsDir),
    libraryDirs: config.libraryDirs.map(expandPath),
  };
}
export async function loadSettings(paths = appPaths()): Promise<Settings> {
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  try {
    return validateSettings(JSON.parse(await readFile(paths.settings, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    if (error instanceof SyntaxError)
      throw new MusicDLError(`Configuration is not valid JSON: ${paths.settings}`, 'CONFIG');
    throw error;
  }
}
export async function saveSettings(config: Settings, paths = appPaths()): Promise<Settings> {
  const valid = validateSettings(config);
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  const temp = `${paths.settings}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, paths.settings);
  return valid;
}
