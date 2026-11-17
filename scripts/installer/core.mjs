import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

export function compatibleNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return !!match && (+match[1] > 24 || (+match[1] === 24 && +match[2] >= 12));
}
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
const binDirectory = (o) =>
  o.binDir ??
  o.env?.MUSICDL_BIN_DIR ??
  (o.platform === 'win32'
    ? path.join(o.home, 'AppData', 'Local', 'MusicDL', 'bin')
    : path.join(o.home, '.local', 'bin'));
const toolDirectory = (o) =>
  path.join(o.root, '.tools', 'spotdl', o.platform === 'win32' ? 'Scripts' : 'bin');

export async function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    stdio: options.inherit ? 'inherit' : 'pipe',
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.error?.message ?? result.stderr ?? '',
  };
}
async function execute(o, command, args, inherit = false) {
  return (o.exec ?? run)(command, args, { root: o.root, env: o.env, inherit });
}
async function requireRun(o, command, args) {
  const result = await execute(o, command, args, true);
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} ${args.join(' ')} failed (${result.status}). ${result.stderr ?? ''}`,
    );
  return result;
}
async function confirm(message) {
  if (!process.stdin.isTTY) return false;
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await reader.question(`${message}\nContinue? [y/N] `)).trim());
  } finally {
    reader.close();
  }
}
async function download(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    headers: { 'User-Agent': 'MusicDL-installer', Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
export async function verifiedDownload(url, target, algorithm, expected, fetchBytes = download) {
  const body = await fetchBytes(url);
  if (createHash(algorithm).update(body).digest('hex') !== expected.toLowerCase())
    throw new Error(`Checksum integrity failure: ${url}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

export async function registerLauncher(options) {
  const o = {
    home: homedir(),
    platform: process.platform,
    node: process.execPath,
    env: process.env,
    ...options,
  };
  const bin = binDirectory(o);
  const target = path.join(bin, o.platform === 'win32' ? 'musicdl.cmd' : 'musicdl');
  const script = path.join(o.root, 'bin', 'musicdl.mjs');
  if ([o.node, script, bin, toolDirectory(o)].some((item) => /[\r\n\0]/.test(item)))
    throw new Error('Unsupported newline in installation path.');
  const marker = `MusicDL managed launcher ${JSON.stringify(o.root)}`;
  let present = false;
  try {
    const stat = await lstat(target);
    present = true;
    if (stat.isSymbolicLink()) {
      if (path.resolve(bin, await readlink(target)) !== script)
        throw new Error(`Refusing unrelated launcher at ${target}`);
    } else {
      const old = await readFile(target, 'utf8');
      const legacyWindows = `@echo off\r\nnode "${script}" %*\r\n`;
      const ownedLegacy = o.platform === 'win32' && old === legacyWindows;
      if (
        !ownedLegacy &&
        !old.split(/\r?\n/).includes(`${o.platform === 'win32' ? 'rem' : '#'} ${marker}`)
      )
        throw new Error(`Refusing unrelated launcher at ${target}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const cmdQuote = (value) => `"${value.replaceAll('%', '%%')}"`;
  const runtimePaths = [
    toolDirectory(o),
    path.dirname(o.node),
    ...(o.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
  ];
  const content =
    o.platform === 'win32'
      ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%p in ('chcp') do set "_MUSICDL_CODEPAGE=%%p"\r\nchcp 65001 >nul\r\nrem ${marker}\r\nset "PATH=${toolDirectory(o).replaceAll('%', '%%')};${path.dirname(o.node).replaceAll('%', '%%')};%PATH%"\r\n${cmdQuote(o.node)} ${cmdQuote(script)} %*\r\nset "_MUSICDL_EXIT=%errorlevel%"\r\nif defined _MUSICDL_CODEPAGE chcp %_MUSICDL_CODEPAGE% >nul\r\nexit /b %_MUSICDL_EXIT%\r\n`
      : `#!/bin/sh\n# ${marker}\nexport PATH=${quote(runtimePaths.join(':'))}:"$PATH"\nexec ${quote(o.node)} ${quote(script)} "$@"\n`;
  await mkdir(bin, { recursive: true });
  const temporary = `${target}.musicdl-${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o755, flag: 'wx' });
    await chmod(temporary, 0o755);
    // Windows cannot rename over an existing file; only the validated owned file is removed.
    if (o.platform === 'win32' && present) await rm(target);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

export async function updatePosixPath(options) {
  const o = { home: homedir(), env: process.env, ...options };
  const bin = binDirectory(o);
  const shell = path.basename(o.env.SHELL ?? 'bash');
  if (!['bash', 'zsh', 'sh', 'fish'].includes(shell))
    throw new Error(
      `Unsupported shell ${shell}; add ${bin} to PATH manually and retry with SHELL=/bin/bash.`,
    );
  let loginProfile = '.profile';
  for (const candidate of ['.bash_profile', '.bash_login']) {
    if (await exists(path.join(o.home, candidate))) {
      loginProfile = candidate;
      break;
    }
  }
  const profiles =
    shell === 'zsh'
      ? ['.zshrc']
      : shell === 'fish'
        ? ['.config/fish/conf.d/musicdl.fish']
        : shell === 'bash'
          ? ['.bashrc', loginProfile]
          : ['.profile'];
  const begin = '# >>> MusicDL PATH >>>';
  const end = '# <<< MusicDL PATH <<<';
  for (const relative of profiles) {
    const file = path.join(o.home, relative);
    const old = await readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const start = old.indexOf(begin);
    const finish = old.indexOf(end);
    if (start < 0 !== finish < 0 || (start >= 0 && finish < start))
      throw new Error(`Malformed MusicDL PATH block in ${file}; repair it before retrying.`);
    const body =
      shell === 'fish'
        ? `fish_add_path -- ${quote(bin)}`
        : `case ":$PATH:" in\n  *:${quote(bin)}:*) ;;\n  *) export PATH=${quote(bin)}:"$PATH" ;;\nesac`;
    const block = `${begin}\n${body}\n${end}`;
    const next =
      start >= 0
        ? old.slice(0, start) + block + old.slice(finish + end.length)
        : `${old}${old && !old.endsWith('\n') ? '\n' : ''}\n${block}\n`;
    if (old !== next) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, next);
    }
  }
}

async function powershell(o, script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return requireRun(o, 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ]);
}
export async function updateWindowsPath(o) {
  const bin = binDirectory(o);
  await powershell(
    o,
    `$ErrorActionPreference='Stop'; $p=[Environment]::GetEnvironmentVariable('Path','User'); $b=${psQuote(bin)}; if (@($p -split ';' | ForEach-Object { $_.TrimEnd('\\') }) -inotcontains $b.TrimEnd('\\')) { [Environment]::SetEnvironmentVariable('Path', (($b,$p | Where-Object { $_ }) -join ';'), 'User') }`,
  );
}

async function ensureFfmpeg(o) {
  const missing = [];
  for (const name of ['ffmpeg', 'ffprobe'])
    if ((await execute(o, name, ['-version'])).status !== 0) missing.push(name);
  if (!missing.length) return;
  if (o.mode !== 'install' || o.noSystem)
    throw new Error(
      `Missing prerequisites: ${missing.join(', ')}. Install FFmpeg including ffprobe; system installation is disabled.`,
    );
  if (o.platform === 'win32' && o.arch === 'arm64')
    throw new Error(
      'Windows ARM64 requires native ffmpeg and ffprobe on PATH. The Gyan.FFmpeg winget package is x64-only; no emulation will be installed.',
    );
  let commands;
  if (o.platform === 'darwin') {
    if ((await execute(o, 'brew', ['--version'])).status !== 0) {
      const url = 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh';
      const staging = await mkdtemp(path.join(tmpdir(), 'musicdl-homebrew-'));
      const installer = path.join(staging, 'install.sh');
      try {
        const description = `Install Homebrew using its official installer from ${url}\nDownload to ${installer}, then run: /bin/bash ${quote(installer)}\nHomebrew may request administrator access and Apple command-line tools. Review https://docs.brew.sh/Installation before approving.`;
        o.log(description);
        if (!(await o.confirm(description)))
          throw new Error(
            'Homebrew bootstrap declined. Provide ffmpeg and ffprobe on PATH, then retry.',
          );
        await writeFile(installer, await o.download(url), { mode: 0o700 });
        await requireRun(o, '/bin/bash', [installer]);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      if ((await execute(o, 'brew', ['--version'])).status !== 0)
        throw new Error(
          'Homebrew installer finished but brew is unavailable. Open a new terminal, follow https://docs.brew.sh/Installation, then retry.',
        );
    }
    commands = [['brew', ['install', 'ffmpeg']]];
  } else if (o.platform === 'win32') {
    if ((await execute(o, 'winget', ['--version'])).status !== 0)
      throw new Error(
        'FFmpeg is missing. Install App Installer/winget from https://learn.microsoft.com/windows/package-manager/winget/install or provide ffmpeg and ffprobe on PATH.',
      );
    commands = [
      [
        'winget',
        [
          'install',
          '--id',
          'Gyan.FFmpeg',
          '--exact',
          '--source',
          'winget',
          '--architecture',
          'x64',
        ],
      ],
    ];
  } else {
    const managers = [
      [
        'apt-get',
        [
          ['sudo', ['apt-get', 'update']],
          ['sudo', ['apt-get', 'install', 'ffmpeg']],
        ],
      ],
      ['dnf', [['sudo', ['dnf', 'install', 'ffmpeg']]]],
      ['pacman', [['sudo', ['pacman', '-S', 'ffmpeg']]]],
      ['zypper', [['sudo', ['zypper', 'install', 'ffmpeg']]]],
    ];
    for (const [manager, planned] of managers)
      if ((await execute(o, manager, ['--version'])).status === 0) {
        commands = planned;
        break;
      }
    if (!commands)
      throw new Error(
        'No supported package manager found. Provide ffmpeg AND ffprobe on PATH, then retry.',
      );
  }
  const description = commands.map(([cmd, args]) => [cmd, ...args].join(' ')).join('\n');
  o.log(`System package changes requested:\n${description}`);
  if (!(await o.confirm(description)))
    throw new Error(
      'System package installation declined. Install ffmpeg and ffprobe manually, then retry.',
    );
  for (const [command, args] of commands) await requireRun(o, command, args);
  if (o.platform === 'win32') {
    const result = await execute(o, 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$p=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))",
    ]);
    if (result.status === 0)
      o.env.PATH = `${Buffer.from(result.stdout.trim(), 'base64').toString('utf8')};${o.env.PATH ?? ''}`;
  }
  for (const name of ['ffmpeg', 'ffprobe'])
    if ((await execute(o, name, ['-version'])).status !== 0)
      throw new Error(
        `${name} still unavailable after package installation. Open a new terminal and retry, or add its directory to PATH.`,
      );
}

export async function ensurePnpm(o) {
  if (o.pnpm) return typeof o.pnpm === 'string' ? { command: o.node, prefix: [o.pnpm] } : o.pnpm;
  const metadata = JSON.parse(await readFile(path.join(o.root, 'package.json'), 'utf8'));
  const version = /^pnpm@(\d+\.\d+\.\d+)$/.exec(metadata.packageManager)?.[1];
  if (!version) throw new Error('package.json must pin an exact pnpm version.');
  const musl =
    o.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : '';
  const target = `${o.platform}-${o.arch}${musl}`;
  const name = `@pnpm/exe.${target}`;
  const directory = path.join(o.root, '.tools', `pnpm-native-${version}-${target}`);
  const manifest = path.join(directory, 'package', 'package.json');
  if (!(await exists(manifest))) {
    if (o.mode !== 'install')
      throw new Error(`Missing isolated pnpm ${version}; run the installer to download it.`);
    const parent = JSON.parse(
      (await o.download(`https://registry.npmjs.org/pnpm/${version}`)).toString(),
    );
    if (parent.optionalDependencies?.[name] !== version)
      throw new Error(`pnpm ${version} has no compatible native package for ${target}.`);
    const pkg = JSON.parse(
      (
        await o.download(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`)
      ).toString(),
    );
    const integrity = pkg.dist?.integrity?.split(' ').find((item) => item.startsWith('sha512-'));
    if (!integrity || !pkg.dist.tarball.startsWith('https://registry.npmjs.org/'))
      throw new Error('pnpm registry integrity metadata is unavailable.');
    await mkdir(path.join(o.root, '.tools'), { recursive: true });
    const staging = await mkdtemp(path.join(o.root, '.tools', 'pnpm-download-'));
    try {
      const archive = path.join(staging, 'pnpm.tgz');
      await verifiedDownload(
        pkg.dist.tarball,
        archive,
        'sha512',
        Buffer.from(integrity.slice(7), 'base64').toString('hex'),
        o.download,
      );
      await requireRun(o, 'tar', ['-xzf', archive, '-C', staging]);
      await rm(archive);
      await rename(staging, directory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const pkg = JSON.parse(await readFile(manifest, 'utf8'));
  if (pkg.name !== name || pkg.version !== version)
    throw new Error('Invalid isolated pnpm platform package.');
  const command = path.join(directory, 'package', o.platform === 'win32' ? 'pnpm.exe' : 'pnpm');
  if (o.mode === 'install') await chmod(command, 0o755);
  const result = await execute(o, command, ['--version']);
  if (result.status !== 0 || result.stdout.trim() !== version)
    throw new Error(`Isolated pnpm ${version} verification failed.`);
  return { command, prefix: [] };
}

async function ensureUv(o) {
  if (
    !(o.platform === 'win32' && o.arch === 'arm64') &&
    (await execute(o, 'uv', ['--version'])).status === 0
  )
    return 'uv';
  const version = '0.13.8';
  const suffix = o.platform === 'win32' ? '.exe' : '';
  const directory = path.join(o.root, '.tools', `uv-${version}`);
  const command = path.join(directory, `uv${suffix}`);
  if (await exists(command)) return command;
  if (o.mode !== 'install')
    throw new Error('uv is missing; run the installer to acquire isolated uv/Python.');
  const cpu = { arm64: 'aarch64', x64: 'x86_64' }[o.arch];
  const target =
    o.platform === 'darwin'
      ? `${cpu}-apple-darwin`
      : o.platform === 'win32'
        ? `${cpu}-pc-windows-msvc`
        : `${cpu}-unknown-linux-gnu`;
  const archiveName = `uv-${target}.${o.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const release = JSON.parse(
    (
      await o.download(`https://api.github.com/repos/astral-sh/uv/releases/tags/${version}`)
    ).toString(),
  );
  const asset = release.assets?.find((item) => item.name === archiveName);
  const sha = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
  if (!sha || !asset.browser_download_url.startsWith('https://github.com/astral-sh/uv/releases/'))
    throw new Error(
      `No verified uv binary available for ${target}; install uv from https://docs.astral.sh/uv/getting-started/installation/ and retry.`,
    );
  const archive = path.join(directory, archiveName);
  await verifiedDownload(asset.browser_download_url, archive, 'sha256', sha, o.download);
  if (o.platform === 'win32')
    await powershell(
      o,
      `Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(directory)} -Force`,
    );
  else await requireRun(o, 'tar', ['-xzf', archive, '-C', directory, '--strip-components=1']);
  await rm(archive);
  await chmod(command, 0o755);
  if ((await execute(o, command, ['--version'])).status !== 0)
    throw new Error('Downloaded uv cannot run on this platform.');
  return command;
}
export async function setupTools(options) {
  const o = defaults(options);
  const uv = await ensureUv(o);
  const environment = path.join(o.root, '.tools', 'spotdl');
  const python = path.join(toolDirectory(o), o.platform === 'win32' ? 'python.exe' : 'python');
  const spotdl = path.join(toolDirectory(o), o.platform === 'win32' ? 'spotdl.exe' : 'spotdl');
  const ytdlp = path.join(toolDirectory(o), o.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (o.mode === 'install') {
    await requireRun(o, uv, [
      'venv',
      '--python',
      '3.13',
      '--managed-python',
      '--allow-existing',
      environment,
    ]);
    await requireRun(o, uv, [
      'pip',
      'install',
      '--python',
      python,
      'spotdl==4.6.0',
      'yt-dlp==2026.10.26',
    ]);
  }
  for (const [command, version] of [
    [python, '3.13.'],
    [spotdl, '4.6.0'],
    [ytdlp, '2026.10.26'],
  ]) {
    const result = await execute(o, command, ['--version']);
    if (result.status !== 0 || !`${result.stdout}\n${result.stderr ?? ''}`.includes(version))
      throw new Error(
        `Missing or incompatible ${path.basename(command)}; expected ${version}. Rerun setup:tools.`,
      );
  }
  return { uv, environment };
}
function defaults(options) {
  const o = {
    root: process.cwd(),
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
    node: process.execPath,
    mode: 'install',
    confirm,
    log: console.log,
    download,
    ...options,
  };
  o.env = { ...process.env, ...(options?.env ?? {}) };
  // Keep downloaded Python, cache, and managed executables inside this checkout.
  o.env.UV_PYTHON_INSTALL_DIR = path.join(o.root, '.tools', 'python');
  o.env.UV_CACHE_DIR = path.join(o.root, '.tools', 'uv-cache');
  o.env.UV_PYTHON_BIN_DIR = path.join(o.root, '.tools', 'python-bin');
  o.env.PATH = [
    toolDirectory(o),
    path.dirname(o.node),
    ...(o.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
    o.env.PATH ?? '',
  ].join(o.platform === 'win32' ? ';' : ':');
  return o;
}
async function runDoctor(o) {
  const state = await mkdtemp(path.join(tmpdir(), 'musicdl-installer-doctor-'));
  try {
    await requireRun({ ...o, env: { ...o.env, MUSICDL_HOME: state } }, o.node, [
      path.join(o.root, 'bin', 'musicdl.mjs'),
      'doctor',
    ]);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}
export async function install(options = {}) {
  const o = defaults(options);
  const nativeWindowsCpu = (
    o.env.PROCESSOR_ARCHITEW6432 ??
    o.env.PROCESSOR_ARCHITECTURE ??
    ''
  ).toUpperCase();
  if (o.platform === 'win32' && nativeWindowsCpu === 'ARM64' && o.arch !== 'arm64')
    throw new Error(
      'Native Windows ARM64 requires native ARM64 Node. Run .\\install.ps1 to bootstrap it.',
    );
  if (!['darwin', 'linux', 'win32'].includes(o.platform) || !['arm64', 'x64'].includes(o.arch))
    throw new Error(`Unsupported platform: ${o.platform}/${o.arch}.`);
  if (!compatibleNode(process.versions.node))
    throw new Error('Node.js >=24.12 is required; use install.sh or install.ps1 to bootstrap it.');
  o.log(`MusicDL setup: ${o.platform}/${o.arch}; Node ${process.versions.node}; ${o.mode}`);
  await ensureFfmpeg(o);
  const pnpm = await ensurePnpm(o);
  await setupTools(o);
  if (o.mode !== 'install') {
    await runDoctor(o);
    return { ok: true, checked: true };
  }
  await requireRun(o, pnpm.command, [...pnpm.prefix, 'install', '--frozen-lockfile']);
  await requireRun(o, pnpm.command, [...pnpm.prefix, 'build']);
  await runDoctor(o);
  const command = await registerLauncher(o);
  if (o.platform === 'win32') await updateWindowsPath(o);
  else await updatePosixPath(o);
  o.log(
    `MusicDL installed successfully: ${command}\nDoctor passed. Open a new terminal, then run musicdl. Re-running setup preserves your settings and library.`,
  );
  return { ok: true, command, binDir: binDirectory(o) };
}
