import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WorkerLock } from '../src/storage/lock.js';
describe('single-worker ownership', () => {
  it('allows only one owner and releases ownership for the next instance', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'musicdl-lock-')),
      file = path.join(directory, 'worker.lock');
    const first = new WorkerLock(file),
      second = new WorkerLock(file);
    await first.acquire();
    await expect(second.acquire()).rejects.toMatchObject({ code: 'LOCKED' });
    await first.release();
    await second.acquire();
    await second.release();
  });
});
