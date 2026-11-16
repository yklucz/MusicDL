#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { chmod, mkdir, readlink, symlink, lstat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const built = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  },
);
if (built.status !== 0) throw new Error('Build failed; launcher was not installed.');
const launcher = path.join(root, 'bin', 'musicdl.mjs');
await chmod(launcher, 0o755);
const destination =
  process.env.MUSICDL_BIN_DIR ??
  (process.platform === 'win32'
    ? path.join(
        process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
        'MusicDL',
        'bin',
      )
    : path.join(homedir(), '.local', 'bin'));
await mkdir(destination, { recursive: true });
if (process.platform === 'win32') {
  const command = path.join(destination, 'musicdl.cmd');
  try {
    await writeFile(command, `@echo off\r\nnode "${launcher}" %*\r\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Existing ${command} retained.`);
  }
} else {
  const command = path.join(destination, 'musicdl');
  try {
    await lstat(command);
    if ((await readlink(command)) !== launcher)
      throw new Error(`A different launcher already exists at ${command}. It was retained.`);
  } catch (error) {
    if (error.code === 'ENOENT') await symlink(launcher, command);
    else throw error;
  }
}
console.log(`MusicDL launcher installed in ${destination}`);
if (!(process.env.PATH ?? '').split(path.delimiter).includes(destination))
  console.log(`Add ${destination} to PATH, then open a new terminal.`);
console.log(
  'Run musicdl doctor, then musicdl. Optional isolated download tools: pnpm setup:tools.',
);
