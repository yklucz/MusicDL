import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  access,
  readdir,
  stat,
  copyFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  compatibleNode,
  registerLauncher,
  updatePosixPath,
  install,
  verifiedDownload,
  setupTools,
  ensurePnpm,
} from '../scripts/installer/core.mjs';

async function fixture(fn) {
  const base = await mkdtemp(path.join(tmpdir(), 'MusicDL cài đặt '));
  try {
    const root = path.join(base, 'project');
    const home = path.join(base, 'home');
    await mkdir(path.join(root, 'bin'), { recursive: true });
    await mkdir(home);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@12.21.0' }),
    );
    await fn({ root, home, base });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function harness({ root, home, ...options }) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    if (options.fail && args.includes(options.fail))
      return { status: 9, stdout: '', stderr: 'controlled failure' };
    if (cmd === 'ffmpeg' || cmd === 'ffprobe')
      return { status: options.missingFF ? 1 : 0, stdout: 'ffmpeg version test' };
    if (cmd === 'brew' || cmd === 'winget') return { status: 0, stdout: 'available' };
    if (cmd === 'uv') return { status: 0, stdout: 'uv 0.13.8' };
    if (args.includes('--version'))
      return {
        status: 0,
        stdout: path.basename(cmd).includes('pnpm')
          ? '12.21.0'
          : path.basename(cmd).includes('python')
            ? 'Python 3.13.9'
            : path.basename(cmd).includes('spotdl')
              ? '4.6.0'
              : '2026.10.26',
      };
    return { status: 0, stdout: '' };
  };
  return {
    root,
    home,
    platform: 'darwin',
    arch: 'arm64',
    env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
    node: process.execPath,
    exec,
    calls,
    confirm: async () => false,
    ...options,
  };
}

// A lower Node version must never reach build or become the launcher's interpreter.
test('Node selection enforces the minimum without excluding newer majors', () => {
  assert.equal(compatibleNode('v24.11.9'), false);
  assert.equal(compatibleNode('24.12.0'), true);
  assert.equal(compatibleNode('26.0.0'), true);
  assert.equal(compatibleNode('garbage'), false);
});

test('launcher pins selected Node and tool PATH, handles Unicode and spaces, and repeats safely', () =>
  fixture(async ({ root, home }) => {
    const node = path.join(home, 'selected node');
    if (process.platform === 'win32') await writeFile(node + '.unused', 'unused');
    else await symlink(process.execPath, node);
    await writeFile(
      path.join(root, 'bin', 'musicdl.mjs'),
      'console.log(process.env.PATH); console.log(process.argv.slice(2).join("|"));',
    );
    const options = {
      root,
      home,
      node: process.platform === 'win32' ? process.execPath : node,
      platform: process.platform,
      env: { PATH: '/usr/bin' },
    };
    const command = await registerLauncher(options);
    await registerLauncher(options);
    const child =
      process.platform === 'win32'
        ? spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `""${command}" "a b" Việt"`], {
            encoding: 'utf8',
            windowsVerbatimArguments: true,
            env: process.env,
          })
        : spawnSync(command, ['a b', 'Việt'], { encoding: 'utf8', env: { PATH: '/usr/bin' } });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /\.tools[\\/]spotdl[\\/](bin|Scripts)/);
    assert.match(child.stdout, /a b\|Việt/);
  }));

test('unrelated launcher is preserved and refused', () =>
  fixture(async ({ root, home }) => {
    const bin = path.join(home, '.local', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'musicdl'), 'personal command');
    await assert.rejects(
      registerLauncher({ root, home, node: process.execPath, platform: 'darwin' }),
      /unrelated|different/i,
    );
    assert.equal(await readFile(path.join(bin, 'musicdl'), 'utf8'), 'personal command');
  }));

test(
  'legacy owned symlink is upgraded without touching its target',
  { skip: process.platform === 'win32' },
  () =>
    fixture(async ({ root, home }) => {
      const bin = path.join(home, '.local', 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(root, 'bin', 'musicdl.mjs'), 'original');
      await symlink(path.join(root, 'bin', 'musicdl.mjs'), path.join(bin, 'musicdl'));
      await registerLauncher({ root, home, node: process.execPath, platform: 'darwin' });
      assert.equal(await readFile(path.join(root, 'bin', 'musicdl.mjs'), 'utf8'), 'original');
      assert.match(await readFile(path.join(bin, 'musicdl'), 'utf8'), /MusicDL managed launcher/);
    }),
);

test(
  'managed shell PATH blocks preserve content and remain idempotent',
  { skip: process.platform === 'win32' },
  () =>
    fixture(async ({ home }) => {
      const profile = path.join(home, '.bashrc');
      const original = '# my profile\nexport CUSTOM="keep"\n';
      await writeFile(profile, original);
      const options = {
        home,
        binDir: path.join(home, "bin ' Việt"),
        env: { SHELL: '/bin/bash' },
        platform: 'darwin',
      };
      await updatePosixPath(options);
      const once = await readFile(profile, 'utf8');
      await updatePosixPath(options);
      assert.equal(await readFile(profile, 'utf8'), once);
      assert.ok(once.startsWith(original));
      const child = spawnSync(
        '/bin/bash',
        ['-c', `source "$1"; printf '%s\\n' "$PATH"`, '--', profile],
        { encoding: 'utf8', env: { PATH: '/usr/bin' } },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.ok(child.stdout.includes(options.binDir));
    }),
);

test('verified download rejects tampering before creating destination', () =>
  fixture(async ({ base }) => {
    const target = path.join(base, 'download');
    await assert.rejects(
      verifiedDownload(
        'https://example.invalid/asset',
        target,
        'sha256',
        '00'.repeat(32),
        async () => Buffer.from('bad'),
      ),
      /checksum|integrity/i,
    );
    await assert.rejects(access(target));
    const body = Buffer.from('trusted');
    await verifiedDownload(
      'https://example.invalid/asset',
      target,
      'sha256',
      createHash('sha256').update(body).digest('hex'),
      async () => body,
    );
    assert.equal(await readFile(target, 'utf8'), 'trusted');
  }));

test('strict check reports missing dependencies and makes no files or install calls', () =>
  fixture(async (f) => {
    const options = harness({ ...f, mode: 'check', missingFF: true });
    await assert.rejects(install(options), /ffmpeg|ffprobe|prerequisite/i);
    await assert.rejects(access(path.join(f.root, '.tools')));
    assert.equal(
      options.calls.some(([, args]) => args.includes('install')),
      false,
    );
  }));

test('declining system changes stops before dependency downloads', () =>
  fixture(async (f) => {
    const options = harness({ ...f, missingFF: true });
    await assert.rejects(install(options), /declined/i);
    await assert.rejects(access(path.join(f.home, '.local')));
  }));

test('no-system refuses missing ffprobe without prompting', () =>
  fixture(async (f) => {
    await assert.rejects(
      install(
        harness({
          ...f,
          missingFF: true,
          noSystem: true,
          confirm: async () => {
            throw new Error('unexpected prompt');
          },
        }),
      ),
      /system|ffmpeg|ffprobe/i,
    );
  }));

test('Windows ARM64 refuses the x64-only package-manager fallback', () =>
  fixture(async (f) => {
    await assert.rejects(
      install(harness({ ...f, missingFF: true, platform: 'win32', arch: 'arm64' })),
      /ARM64|arm64/,
    );
  }));

test('failed frozen install leaves launcher and profile absent', () =>
  fixture(async (f) => {
    const options = harness({ ...f, fail: '--frozen-lockfile', pnpm: '/portable/pnpm.mjs' });
    await assert.rejects(install(options), /failed|failure/i);
    await assert.rejects(access(path.join(f.home, '.zshrc')));
    await assert.rejects(access(path.join(f.home, '.local', 'bin', 'musicdl')));
  }));

test('successful setup builds, diagnoses, registers and repeats without changing user data', () =>
  fixture(async (f) => {
    const settings = path.join(f.home, 'settings.json');
    await writeFile(settings, '{"personal":true}\n');
    const options = harness({ ...f, pnpm: '/portable/pnpm.mjs' });
    const first = await install(options);
    const profile = await readFile(path.join(f.home, '.zshrc'), 'utf8');
    await install(options);
    assert.equal(first.ok, true);
    assert.equal(await readFile(path.join(f.home, '.zshrc'), 'utf8'), profile);
    assert.equal(await readFile(settings, 'utf8'), '{"personal":true}\n');
    assert.ok(options.calls.some(([, args]) => args.includes('doctor')));
  }));

test('doctor failure prevents a misleading successful installation', () =>
  fixture(async (f) => {
    await assert.rejects(
      install(harness({ ...f, pnpm: '/portable/pnpm.mjs', fail: 'doctor' })),
      /doctor|failed/i,
    );
    await assert.rejects(access(path.join(f.home, '.local', 'bin', 'musicdl')));
  }));

test(
  'native Bash help works without downloads or changes',
  { skip: process.platform === 'win32' },
  () => {
    const child = spawnSync('bash', ['./install.sh', '--help'], {
      encoding: 'utf8',
      cwd: new URL('..', import.meta.url),
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /--check/);
    assert.match(child.stdout, /--no-system/);
  },
);

test('installer doctor uses disposable state instead of opening the user database', () =>
  fixture(async (f) => {
    const options = harness({ ...f, pnpm: '/portable/pnpm.mjs' });
    const original = options.exec;
    options.exec = async (cmd, args, invocation) => {
      if (args.includes('doctor')) {
        assert.ok(invocation.env.MUSICDL_HOME, 'doctor must isolate application state');
        assert.notEqual(invocation.env.MUSICDL_HOME, process.env.MUSICDL_HOME);
        assert.ok(!invocation.env.MUSICDL_HOME.startsWith(f.home));
      }
      return original(cmd, args);
    };
    await install(options);
  }));

test(
  'native Bash check rejects an old Node without bootstrapping or touching profiles',
  { skip: process.platform === 'win32' },
  () =>
    fixture(async (f) => {
      await mkdir(path.join(f.base, 'fake-bin'));
      await writeFile(path.join(f.base, 'fake-bin', 'node'), '#!/bin/sh\nexit 1\n', {
        mode: 0o755,
      });
      await writeFile(
        path.join(f.root, 'install.sh'),
        await readFile(new URL('../install.sh', import.meta.url)),
      );
      const child = spawnSync('bash', [path.join(f.root, 'install.sh'), '--check'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: f.home,
          PATH: `${path.join(f.base, 'fake-bin')}:/usr/bin:/bin`,
        },
      });
      assert.equal(child.status, 1);
      assert.match(child.stderr, /Node\.js >=24\.12/);
      await assert.rejects(access(path.join(f.root, '.tools')));
    }),
);

test(
  'isolated native pnpm acquisition verifies integrity and executes the platform package',
  { skip: process.platform === 'win32' },
  () =>
    fixture(async (f) => {
      const source = path.join(f.base, 'source', 'package');
      await mkdir(path.join(source, 'cli'), { recursive: true });
      await writeFile(
        path.join(source, 'package.json'),
        JSON.stringify({ name: '@pnpm/exe.darwin-arm64', version: '12.21.0' }),
      );
      await writeFile(
        path.join(source, 'pnpm'),
        `#!/bin/sh\nexec '${process.execPath}' '${path.join(source, 'cli', 'custom.mjs')}' "$@"\n`,
        { mode: 0o755 },
      );
      const marker = path.join(f.base, 'pnpm-commands.jsonl');
      await writeFile(
        path.join(source, 'cli', 'custom.mjs'),
        `import fs from 'node:fs'; if(process.argv.includes('--version')) console.log('12.21.0'); else fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))+'\\n');`,
      );
      const archive = path.join(f.base, 'pnpm.tgz');
      const tar = spawnSync('tar', ['-czf', archive, '-C', path.dirname(source), 'package']);
      assert.equal(tar.status, 0);
      const bytes = await readFile(archive);
      const options = harness({ ...f });
      const original = options.exec;
      options.exec = async (cmd, args, invocation) => {
        if (cmd === 'tar' || cmd.includes('pnpm-native-12.21.0')) {
          const result = spawnSync(cmd, args, {
            cwd: invocation.root,
            env: invocation.env,
            encoding: 'utf8',
          });
          return { status: result.status, stdout: result.stdout, stderr: result.stderr };
        }
        return original(cmd, args);
      };
      options.download = async (url) =>
        url === 'https://registry.npmjs.org/pnpm/12.21.0'
          ? Buffer.from(
              JSON.stringify({ optionalDependencies: { '@pnpm/exe.darwin-arm64': '12.21.0' } }),
            )
          : url.endsWith('/12.21.0')
            ? Buffer.from(
                JSON.stringify({
                  dist: {
                    tarball: 'https://registry.npmjs.org/pnpm/-/pnpm-12.21.0.tgz',
                    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
                  },
                }),
              )
            : bytes;
      await install(options);
      assert.equal(await readFile(marker, 'utf8'), '["install","--frozen-lockfile"]\n["build"]\n');
    }),
);

test(
  'native PowerShell help works without downloads or policy changes',
  { skip: process.platform !== 'win32' },
  () => {
    const child = spawnSync('powershell.exe', ['-NoProfile', '-File', 'install.ps1', '-Help'], {
      encoding: 'utf8',
      cwd: new URL('..', import.meta.url),
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /--check/);
    assert.match(child.stdout, /--no-system/);
  },
);

test(
  'Bash bootstraps a verified portable Node and reuses it on a second run',
  { skip: process.platform === 'win32' },
  () =>
    fixture(async (f) => {
      const name = `node-v24.22.3-${process.platform}-${process.arch}`;
      const source = path.join(f.base, 'node-source', name, 'bin');
      await mkdir(source, { recursive: true });
      await writeFile(
        path.join(source, 'node'),
        `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o755 },
      );
      const archive = path.join(f.base, `${name}.tar.gz`);
      assert.equal(
        spawnSync('tar', ['-czf', archive, '-C', path.join(f.base, 'node-source'), name]).status,
        0,
      );
      const bytes = await readFile(archive);
      const checksums = path.join(f.base, 'SHASUMS256.txt');
      await writeFile(
        checksums,
        `${createHash('sha256').update(bytes).digest('hex')}  ${name}.tar.gz\n`,
      );
      const fake = path.join(f.base, 'fake-bin');
      await mkdir(fake);
      await writeFile(path.join(fake, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      await writeFile(
        path.join(fake, 'curl'),
        '#!/bin/sh\nfor arg in "$@"; do\n case "$arg" in\n  *SHASUMS256.txt) src="$TEST_CHECKSUMS" ;;\n  *.tar.gz) src="$TEST_ARCHIVE" ;;\n esac\n if [ "$previous" = -o ]; then dest="$arg"; fi\n previous="$arg"\ndone\ncp "$src" "$dest"\n',
        { mode: 0o755 },
      );
      const ambient = path.join(f.base, 'ambient-staging');
      await mkdir(ambient);
      await writeFile(path.join(ambient, 'keep'), 'unrelated');
      await mkdir(path.join(f.root, 'scripts'));
      await writeFile(
        path.join(f.root, 'scripts', 'install.mjs'),
        'console.log("shared installer reached");',
      );
      await writeFile(
        path.join(f.root, 'install.sh'),
        await readFile(new URL('../install.sh', import.meta.url)),
      );
      const env = {
        ...process.env,
        HOME: f.home,
        PATH: `${fake}:/usr/bin:/bin`,
        TEST_ARCHIVE: archive,
        TEST_CHECKSUMS: checksums,
        STAGING: ambient,
      };
      const first = spawnSync('bash', [path.join(f.root, 'install.sh'), '--no-system'], {
        encoding: 'utf8',
        env,
      });
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /shared installer reached/);
      assert.equal(await readFile(path.join(ambient, 'keep'), 'utf8'), 'unrelated');
      await access(path.join(f.root, '.tools', name, 'bin', 'node'));
      assert.deepEqual(
        await readdir(path.join(f.root, '.tools')),
        [name],
        'bootstrap staging must be removed before exec',
      );
      // Removing the network command proves the installed runtime is reused.
      await rm(path.join(fake, 'curl'));
      const second = spawnSync('bash', [path.join(f.root, 'install.sh'), '--no-system'], {
        encoding: 'utf8',
        env,
      });
      assert.equal(second.status, 0, second.stderr);
      assert.doesNotMatch(second.stdout, /Downloading/);
    }),
);

test('Bash PATH setup preserves existing login profile precedence', () =>
  fixture(async ({ home }) => {
    const profile = path.join(home, '.profile');
    await writeFile(profile, 'export PERSONAL_LOGIN=keep\n');
    await updatePosixPath({
      home,
      binDir: path.join(home, 'bin'),
      env: { SHELL: '/bin/bash' },
      platform: 'linux',
    });
    await assert.rejects(access(path.join(home, '.bash_profile')));
    assert.ok((await readFile(profile, 'utf8')).startsWith('export PERSONAL_LOGIN=keep\n'));
  }));

test(
  'macOS launcher retains the package-manager FFmpeg paths used during setup',
  { skip: process.platform === 'win32' },
  () =>
    fixture(async ({ root, home }) => {
      await writeFile(path.join(root, 'bin', 'musicdl.mjs'), 'console.log(process.env.PATH);');
      const command = await registerLauncher({
        root,
        home,
        node: process.execPath,
        platform: 'darwin',
      });
      const child = spawnSync(command, [], { encoding: 'utf8', env: { PATH: '/usr/bin' } });
      assert.equal(child.status, 0);
      assert.match(child.stdout, /\/opt\/homebrew\/bin/);
      assert.match(child.stdout, /\/usr\/local\/bin/);
    }),
);

test('fresh macOS offers official Homebrew bootstrap and honors a decline without downloading', () =>
  fixture(async (f) => {
    const options = harness({ ...f, missingFF: true, pnpm: '/portable/pnpm.mjs' });
    const original = options.exec;
    let prompted = false;
    options.exec = async (cmd, args, invocation) =>
      cmd === 'brew' ? { status: 1, stdout: '' } : original(cmd, args, invocation);
    options.confirm = async (message) => {
      prompted = true;
      assert.match(message, /https:\/\/raw\.githubusercontent\.com\/Homebrew\/install/);
      return false;
    };
    options.download = async () => {
      throw Error('declined bootstrap must not download');
    };
    await assert.rejects(install(options), /declined/i);
    assert.equal(prompted, true);
  }));

test(
  'confirmed Homebrew bootstrap runs a downloaded installer before confirmed FFmpeg install',
  { skip: process.platform === 'win32' },
  () =>
    fixture(async (f) => {
      const options = harness({ ...f, pnpm: '/portable/pnpm.mjs' });
      const marker = path.join(f.base, 'brew-installed');
      let brew = false;
      let ffmpeg = false;
      const original = options.exec;
      options.exec = async (cmd, args, invocation) => {
        if (cmd === 'brew' && args[0] === '--version') return { status: brew ? 0 : 1, stdout: '' };
        if (cmd === 'ffmpeg' || cmd === 'ffprobe') return { status: ffmpeg ? 0 : 1, stdout: '' };
        if (cmd === '/bin/bash') {
          const child = spawnSync(cmd, args, { env: invocation.env, encoding: 'utf8' });
          brew = await access(marker).then(
            () => true,
            () => false,
          );
          return { status: child.status, stdout: child.stdout, stderr: child.stderr };
        }
        if (cmd === 'brew' && args[0] === 'install') {
          assert.equal(brew, true);
          ffmpeg = true;
          return { status: 0, stdout: '' };
        }
        return original(cmd, args, invocation);
      };
      options.confirm = async () => true;
      options.download = async (url) => {
        assert.equal(url, 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh');
        return Buffer.from(`#!/bin/bash\ntouch '${marker}'\n`);
      };
      await install(options);
      assert.equal(brew, true);
      assert.equal(ffmpeg, true);
    }),
);

test('direct setup refuses x64 emulation on native Windows ARM64', () =>
  fixture(async (f) => {
    await assert.rejects(
      install(
        harness({
          ...f,
          platform: 'win32',
          arch: 'x64',
          env: { PATH: '', PROCESSOR_ARCHITECTURE: 'ARM64' },
        }),
      ),
      /native.*ARM64|ARM64.*native/i,
    );
  }));

test(
  'missing uv is acquired from a verified official release and executes isolated tool setup',
  { skip: process.platform === 'win32' },
  () =>
    fixture(async (f) => {
      const target = 'uv-aarch64-apple-darwin';
      const source = path.join(f.base, 'uv-source', target);
      await mkdir(source, { recursive: true });
      await writeFile(
        path.join(source, 'uv'),
        `#!/bin/sh
if [ "$1" = --version ]; then echo 'uv 0.13.8'; exit 0; fi
if [ "$1" = pip ]; then
  case "$*" in *'spotdl==4.6.0 yt-dlp==2026.10.26') exit 0 ;; *) exit 7 ;; esac
fi
if [ "$1" = venv ]; then
  for arg in "$@"; do destination="$arg"; done
  mkdir -p "$destination/bin"
  printf '#!/bin/sh\\necho "Python 3.13.9"\\n' > "$destination/bin/python"
  printf '#!/bin/sh\\necho "4.6.0"\\n' > "$destination/bin/spotdl"
  printf '#!/bin/sh\\necho "2026.10.26"\\n' > "$destination/bin/yt-dlp"
  chmod +x "$destination/bin/python" "$destination/bin/spotdl" "$destination/bin/yt-dlp"
  exit 0
fi
exit 8
`,
        { mode: 0o755 },
      );
      const archive = path.join(f.base, 'uv.tar.gz');
      assert.equal(
        spawnSync('tar', ['-czf', archive, '-C', path.dirname(source), target]).status,
        0,
      );
      const bytes = await readFile(archive);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const options = harness({ ...f, env: { PATH: '/usr/bin:/bin' } });
      options.exec = async (cmd, args, invocation) => {
        if (cmd === 'uv') return { status: 1, stdout: '' };
        const result = spawnSync(cmd, args, {
          cwd: invocation.root,
          env: invocation.env,
          encoding: 'utf8',
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      };
      const archiveUrl = `https://github.com/astral-sh/uv/releases/download/0.13.8/${target}.tar.gz`;
      options.download = async (url) => {
        if (url === `${archiveUrl}.sha256`) return Buffer.from(`${digest}  ${target}.tar.gz\n`);
        if (url === archiveUrl) return bytes;
        throw new Error(`Unexpected download; GitHub API must not be required: ${url}`);
      };
      const result = await setupTools(options);
      const child = spawnSync(path.join(result.environment, 'bin', 'yt-dlp'), ['--version'], {
        encoding: 'utf8',
      });
      assert.equal(child.status, 0);
      assert.equal(child.stdout.trim(), '2026.10.26');
    }),
);

test(
  'read-only check never changes the isolated pnpm executable mode',
  { skip: process.platform === 'win32' },
  () =>
    fixture(async (f) => {
      const target = `${process.platform}-${process.arch}`;
      const directory = path.join(f.root, '.tools', `pnpm-native-12.21.0-${target}`, 'package');
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({ name: `@pnpm/exe.${target}`, version: '12.21.0' }),
      );
      const executable = path.join(directory, 'pnpm');
      await writeFile(executable, '#!/bin/sh\necho 12.21.0\n', { mode: 0o555 });
      const before = (await stat(executable)).mode;
      await ensurePnpm({
        ...f,
        platform: process.platform,
        arch: process.arch,
        node: process.execPath,
        mode: 'check',
        env: process.env,
      });
      assert.equal((await stat(executable)).mode, before);
    }),
);

test('only the exact legacy Windows launcher for this checkout can be upgraded', () =>
  fixture(async (f) => {
    const binDir = path.join(f.home, 'bin');
    await mkdir(binDir);
    const command = path.join(binDir, 'musicdl.cmd');
    const legacy = `@echo off\r\nnode "${path.join(f.root, 'bin', 'musicdl.mjs')}" %*\r\n`;
    await writeFile(command, legacy);
    const options = { ...f, binDir, node: process.execPath, platform: 'win32', env: {} };
    assert.equal(await registerLauncher(options), command);
    assert.notEqual(await readFile(command, 'utf8'), legacy);
    await registerLauncher(options);
    await writeFile(command, legacy + 'echo custom modification\r\n');
    await assert.rejects(registerLauncher(options), /unrelated/i);
    assert.equal(await readFile(command, 'utf8'), legacy + 'echo custom modification\r\n');
    const foreign = `@echo off\r\nnode "${path.join(f.home, 'different', 'bin', 'musicdl.mjs')}" %*\r\n`;
    await writeFile(command, foreign);
    await assert.rejects(registerLauncher(options), /unrelated/i);
    assert.equal(await readFile(command, 'utf8'), foreign);
  }));

test(
  'Windows launcher supports Unicode paths under CP437 and restores the caller code page',
  { skip: process.platform !== 'win32' },
  () =>
    fixture(async (f) => {
      const selected = path.join(f.home, 'selected Node Việt');
      await mkdir(selected);
      const node = path.join(selected, 'node.exe');
      await copyFile(process.execPath, node);
      await writeFile(
        path.join(f.root, 'bin', 'musicdl.mjs'),
        'console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2),path:process.env.PATH}));',
      );
      const command = await registerLauncher({
        ...f,
        node,
        platform: 'win32',
        env: {},
        binDir: path.join(f.home, 'bin'),
      });
      const caller = path.join(f.base, 'caller.cmd');
      await writeFile(
        caller,
        `@echo off\r\nfor /f "tokens=2 delims=:" %%p in ('chcp') do set "_TEST_CP=%%p"\r\nchcp 437 >nul\r\ncall "%MUSICDL_TEST_COMMAND%" "hello world"\r\nset "_MUSICDL_TEST_EXIT=%errorlevel%"\r\nchcp\r\nif defined _TEST_CP chcp %_TEST_CP% >nul\r\nexit /b %_MUSICDL_TEST_EXIT%\r\n`,
        'ascii',
      );
      const child = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `""${caller}""`], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
        env: { ...process.env, MUSICDL_TEST_COMMAND: command },
      });
      assert.equal(child.status, 0, child.stderr);
      const output = child.stdout.split(/\r?\n/).find((line) => line.startsWith('{'));
      assert.ok(output, child.stdout);
      const result = JSON.parse(output);
      assert.equal(result.node.toLowerCase(), node.toLowerCase());
      assert.deepEqual(result.args, ['hello world']);
      assert.ok(result.path.includes(path.join(f.root, '.tools', 'spotdl', 'Scripts')));
      assert.match(child.stdout, /:\s*437\s*(?:\r?\n|$)/);
    }),
);

test('Windows package-manager PATH refresh preserves Unicode through an ASCII transport', () =>
  fixture(async (f) => {
    const refreshed = `${f.home}\\Ứng dụng\\FFmpeg;C:\\Windows\\System32`;
    const options = harness({
      ...f,
      platform: 'win32',
      arch: 'x64',
      pnpm: '/portable/pnpm.mjs',
      confirm: async () => true,
    });
    const original = options.exec;
    let available = false;
    options.exec = async (cmd, args, invocation) => {
      if (cmd === 'ffmpeg' || cmd === 'ffprobe') return { status: available ? 0 : 1, stdout: '' };
      if (cmd === 'winget' && args[0] === 'install') {
        available = true;
        return { status: 0, stdout: '' };
      }
      if (cmd === 'powershell.exe' && args.includes('-Command'))
        return { status: 0, stdout: Buffer.from(refreshed, 'utf8').toString('base64') + '\r\n' };
      if (args.includes('doctor'))
        assert.ok(
          invocation.env.PATH.includes(refreshed),
          'Unicode user PATH must reach doctor intact',
        );
      return original(cmd, args, invocation);
    };
    await install(options);
  }));

for (const [name, checksum] of [
  ['a different archive name', `${'a'.repeat(64)}  uv-x86_64-pc-windows-msvc.zip\n`],
  ['malformed digest', 'not-a-digest  uv-aarch64-apple-darwin.tar.gz\n'],
  [
    'ambiguous multiple entries',
    `${'a'.repeat(64)}  uv-aarch64-apple-darwin.tar.gz\n${'b'.repeat(64)}  uv-aarch64-apple-darwin.tar.gz\n`,
  ],
]) {
  test(`uv refuses checksum metadata with ${name} before acquiring a binary`, () =>
    fixture(async (f) => {
      const options = harness({ ...f });
      options.exec = async () => ({ status: 1, stdout: '' });
      options.download = async (url) => {
        if (!url.endsWith('/uv-aarch64-apple-darwin.tar.gz.sha256'))
          throw Error(`Unexpected network request: ${url}`);
        return Buffer.from(checksum);
      };
      await assert.rejects(setupTools(options), /checksum.*metadata|metadata.*checksum/i);
      await assert.rejects(access(path.join(f.root, '.tools', 'uv-0.13.8', 'uv')));
    }));
}

test('uv rejects a mismatching static release checksum before extracting executable bytes', () =>
  fixture(async (f) => {
    const options = harness({ ...f });
    options.exec = async () => ({ status: 1, stdout: '' });
    options.download = async (url) => {
      if (url.endsWith('.sha256'))
        return Buffer.from(`${'a'.repeat(64)}  uv-aarch64-apple-darwin.tar.gz\n`);
      if (
        url ===
        'https://github.com/astral-sh/uv/releases/download/0.13.8/uv-aarch64-apple-darwin.tar.gz'
      )
        return Buffer.from('tampered archive');
      throw Error('GitHub API is unavailable and must not be requested');
    };
    await assert.rejects(setupTools(options), /checksum integrity/i);
    await assert.rejects(access(path.join(f.root, '.tools', 'uv-0.13.8', 'uv')));
  }));

test('Windows environment merge honors mixed-case Path precedence without mutating caller state', () =>
  fixture(async (f) => {
    const media = path.join(f.base, 'media tools');
    const tail = `${media};C:\\Windows\\System32`;
    const env = { Path: tail, Shell: '/bin/zsh' };
    const before = { ...process.env };
    const options = harness({
      ...f,
      platform: 'win32',
      arch: 'x64',
      pnpm: '/portable/pnpm.mjs',
      env,
    });
    const original = options.exec;
    options.exec = async (cmd, args, invocation) => {
      if (cmd === 'ffmpeg' || cmd === 'ffprobe' || args.includes('doctor')) {
        const keys = Object.keys(invocation.env).filter((key) => key.toLowerCase() === 'path');
        assert.deepEqual(
          keys,
          ['PATH'],
          'Windows child environment must contain a single canonical PATH',
        );
        assert.ok(
          invocation.env.PATH.endsWith(tail),
          'existing media/system PATH entries must survive tool prefixes',
        );
      }
      return original(cmd, args);
    };
    await install(options);
    assert.deepEqual(env, { Path: tail, Shell: '/bin/zsh' });
    assert.deepEqual({ ...process.env }, before);
  }));

test(
  'native Windows discovers existing media tools from a mixed-case Path input',
  { skip: process.platform !== 'win32' },
  () =>
    fixture(async (f) => {
      const media = path.join(f.base, 'native media tools');
      await mkdir(media);
      for (const name of ['ffmpeg', 'ffprobe'])
        await writeFile(
          path.join(media, `${name}.cmd`),
          `@echo off\r\necho controlled ${name} version\r\n`,
        );
      const options = harness({
        ...f,
        platform: 'win32',
        arch: process.arch,
        pnpm: '/portable/pnpm.mjs',
        env: { Path: media },
      });
      const original = options.exec;
      options.exec = async (cmd, args, invocation) => {
        if (cmd === 'ffmpeg' || cmd === 'ffprobe') {
          const child = spawnSync(
            process.env.ComSpec,
            ['/d', '/s', '/c', `${cmd} ${args.join(' ')}`],
            { encoding: 'utf8', env: invocation.env, windowsVerbatimArguments: true },
          );
          if (child.status === 0)
            assert.match(child.stdout, new RegExp(`controlled ${cmd} version`));
          return { status: child.status, stdout: child.stdout, stderr: child.stderr };
        }
        return original(cmd, args);
      };
      await install(options);
    }),
);
