import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ProcessRunner } from '../src/core/process.js';

it('validates small and 1000-entry SDK pagination, access denial and partial pages', async () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  expect(
    spawnSync(python, ['--version']).status,
    'Python is required by the downloader tools',
  ).toBe(0);
  const result = await new ProcessRunner().run(python, [
    fileURLToPath(new URL('./fixtures/spotify_pages.py', import.meta.url)),
    fileURLToPath(new URL('../scripts/spotify-playlist.py', import.meta.url)),
  ]);
  expect(result.stderr).toContain('OK');
  expect(result.stderr).toContain('Ran 4 tests');
});
