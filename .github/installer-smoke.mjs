// Live installation checks run only on disposable GitHub-hosted CI machines.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { install } from '../scripts/installer/core.mjs';

if (process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('Run live installer smoke checks on disposable GitHub Actions runners.');
const source = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'musicdl-install-ci-'));
const root = path.join(temporary, 'cài đặt 二', 'MusicDL');
const home = path.join(temporary, 'profile');
const binDir = path.join(home, 'bin');
function child(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', shell: false });
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr || result.error?.message || result.stdout}`,
    );
  return result.stdout;
}
let originalUserPath;
if (process.platform === 'win32')
  originalUserPath = child('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Environment]::GetEnvironmentVariable('Path','User')",
  ]).trimEnd();
try {
  await mkdir(root, { recursive: true });
  for (const name of [
    'src',
    'scripts',
    'bin',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'config.example.json',
    'install.sh',
    'install.ps1',
    'README.md',
  ])
    await cp(path.join(source, name), path.join(root, name), { recursive: true });
  const options = {
    root,
    home,
    binDir,
    noSystem: true,
    env: { ...process.env, SHELL: process.platform === 'win32' ? undefined : '/bin/bash' },
  };
  const first = await install(options);
  const second = await install(options);
  assert.equal(first.command, second.command);
  const env = { ...process.env, MUSICDL_HOME: path.join(temporary, 'doctor-state') };
  function launch(args) {
    return process.platform === 'win32'
      ? child('cmd.exe', ['/d', '/s', '/c', `""${first.command}" ${args.join(' ')}"`], env)
      : child(first.command, args, env);
  }
  assert.match(launch(['--version']), /^1\.0\.0\s*$/);
  assert.match(launch(['doctor']), /All required tools and encoders are available/);
  console.log(
    `PASS: ${process.platform}/${process.arch} real isolated installation, rerun, Unicode launcher and doctor.`,
  );
} finally {
  if (originalUserPath !== undefined) {
    const script = `[Environment]::SetEnvironmentVariable('Path','${originalUserPath.replaceAll("'", "''")}','User')`;
    child('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]);
  }
  await rm(temporary, { recursive: true, force: true });
}
