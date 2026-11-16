import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Runner, RunResult } from '../src/core/process.js';
import type { Job } from '../src/core/types.js';
import { defaults } from '../src/settings.js';
import { createPipeline } from '../src/downloads/source.js';
import { AudioProcessor } from '../src/audio/processor.js';
describe('Spotify download boundary', () => {
  const job: Job = {
    id: 'fixture',
    track: {
      key: 'spotify:1234567890123456789012',
      id: '1234567890123456789012',
      provider: 'spotify',
      url: 'https://open.spotify.com/track/1234567890123456789012',
      title: 'Test',
      confidence: 'provider',
    },
    format: 'mp3',
    status: 'queued',
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    nextAttemptAt: 0,
  };
  it('reports a zero-exit failed match and only invokes a single Spotify track', async () => {
    let args: string[] = [];
    const runner: Runner = {
      run: async (_command, received): Promise<RunResult> => {
        args = received;
        return { stdout: 'AudioProviderError: No matching audio found', stderr: '' };
      },
    };
    const config = defaults(),
      staging = await mkdtemp(path.join(tmpdir(), 'musicdl-spotdl-'));
    await expect(
      createPipeline(runner, config, new AudioProcessor(runner, config.tools))(
        job,
        staging,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('No matching audio');
    expect(args.slice(0, 2)).toEqual([
      'download',
      'https://open.spotify.com/track/1234567890123456789012',
    ]);
    expect(args.slice(args.indexOf('--bitrate'), args.indexOf('--bitrate') + 2)).toEqual([
      '--bitrate',
      'disable',
    ]);
  });
  it('makes network failures retryable even when spotDL exits successfully without an output', async () => {
    const runner: Runner = {
      run: async () => ({ stdout: 'Connection timeout HTTP 429', stderr: '' }),
    };
    const config = defaults(),
      staging = await mkdtemp(path.join(tmpdir(), 'musicdl-spotdl-retry-'));
    await expect(
      createPipeline(runner, config, new AudioProcessor(runner, config.tools))(
        job,
        staging,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({ retryable: true });
  });
});
