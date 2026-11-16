import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/storage/store.js';
const exec = promisify(execFile);
async function cli(args: string[], existingHome?: string) {
  const home = existingHome ?? (await mkdtemp(path.join(tmpdir(), 'musicdl-cli-')));
  return exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, MUSICDL_HOME: home },
    timeout: 15_000,
  });
}
describe('CLI contract', () => {
  it('does not inherit failure status from historical jobs when the current queue is empty', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'musicdl-cli-history-'));
    const store = new Store(path.join(home, 'musicdl.sqlite'));
    store.addJob({
      id: 'old-failure',
      track: {
        key: 'old',
        id: 'old',
        provider: 'youtube',
        url: 'https://youtube.com/watch?v=old',
        title: 'Old failure',
        confidence: 'provider',
      },
      format: 'mp3',
      status: 'failed',
      attempts: 1,
      createdAt: 1,
      updatedAt: 1,
      nextAttemptAt: 0,
    });
    store.close();
    const result = await cli(['queue', 'run'], home);
    expect(result.stdout).not.toContain('Old failure');
  });
  it('honors global selection flags before a download subcommand', async () => {
    await expect(
      cli(['--single', 'download', 'https://example.org/test', '--playlist']),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('together') });
  });
  it('provides the required commands and explicit mixed-link overrides', async () => {
    const result = await cli(['--help']);
    for (const command of [
      'download',
      'search',
      'queue',
      'library',
      'playlists',
      'history',
      'config',
      'doctor',
      '--single',
      '--playlist',
    ])
      expect(result.stdout).toContain(command);
  });
  it('rejects unsupported formats before accessing a provider', async () => {
    await expect(
      cli(['download', 'https://example.org/test', '--format', 'zip']),
    ).rejects.toMatchObject({ code: 1 });
  });
  it('reads an empty persistent queue without downloading', async () => {
    const result = await cli(['queue', '--json']);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
  it('validates unsafe URL input without launching a download tool', async () => {
    await expect(cli(['download', 'file:///etc/passwd'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('HTTP'),
    });
  });
});
