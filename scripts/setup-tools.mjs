#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
try {
  const environment = path.join(root, '.tools', 'spotdl');
  run('uv', ['venv', '--python', '3.13', '--allow-existing', environment]);
  const python = path.join(
    environment,
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  run('uv', ['pip', 'install', '--python', python, 'spotdl==4.6.0', 'yt-dlp==2026.10.26']);
  console.log(
    'Official spotDL and yt-dlp are installed in .tools/spotdl. FFmpeg and ffprobe must be installed separately.',
  );
  console.log(
    'spotDL is discovered automatically. If yt-dlp is absent from PATH, set tools.ytdlp to .tools/spotdl/bin/yt-dlp (Windows: Scripts/yt-dlp.exe) using musicdl config set.',
  );
} catch (error) {
  console.error(
    `Tool setup failed: ${error.message}\nInstall uv from https://docs.astral.sh/uv/ and retry, or install official spotDL/yt-dlp separately and configure their executable paths.`,
  );
  process.exitCode = 1;
}
