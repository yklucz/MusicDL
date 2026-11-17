import { spawn } from 'node:child_process';
import { MusicDLError, abortError } from './errors.js';
import { redact } from './safety.js';

export interface RunOptions {
  signal?: AbortSignal | undefined;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutput?: number | undefined;
  onLine?: ((line: string) => void) | undefined;
}
export interface RunResult {
  stdout: string;
  stderr: string;
}
export interface Runner {
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
}
export class ProcessRunner implements Runner {
  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    if (options.signal?.aborted) throw abortError();
    if (!command || command.includes('\0') || args.some((arg) => arg.includes('\0')))
      throw new MusicDLError('Invalid subprocess argument.', 'INVALID_ARGUMENT');
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      let stdout = '',
        stderr = '',
        total = 0;
      const partial = { stdout: '', stderr: '' };
      let reason: Error | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let timeout: NodeJS.Timeout | undefined;
      const kill = (): void => {
        if (!child.pid) return;
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already stopped */
        }
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => {
            child.kill();
          });
        }
        forceTimer = setTimeout(() => {
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            /* stopped */
          }
        }, 2000);
        forceTimer.unref();
      };
      const abort = (): void => {
        if (!reason) {
          reason = abortError();
          kill();
        }
      };
      const receive = (text: string, isError: boolean): void => {
        total += Buffer.byteLength(text);
        if (total > (options.maxOutput ?? 32 * 1024 * 1024)) {
          if (!reason) {
            reason = new MusicDLError(
              'Tool output exceeded the safety limit. Resolve a smaller collection.',
              'OUTPUT_LIMIT',
            );
            kill();
          }
          return;
        }
        if (isError) stderr = (stderr + text).slice(-32_000);
        else stdout += text;
        if (options.onLine) {
          const channel = isError ? 'stderr' : 'stdout';
          partial[channel] += text;
          const lines = partial[channel].split(/[\r\n]+/);
          partial[channel] = lines.pop() ?? '';
          try {
            for (const line of lines) options.onLine(line);
          } catch (error) {
            if (!reason) {
              reason = error instanceof Error ? error : new Error(String(error));
              kill();
            }
          }
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => receive(chunk, false));
      child.stderr.on('data', (chunk: string) => receive(chunk, true));
      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        options.signal?.removeEventListener('abort', abort);
      };
      child.on('error', (error: NodeJS.ErrnoException) => {
        reason = new MusicDLError(
          error.code === 'ENOENT'
            ? `Required tool is missing: ${command.split(/[\\/]/).at(-1)}. Run musicdl doctor.`
            : `Could not start tool: ${redact(error.message)}`,
          'TOOL_MISSING',
        );
      });
      child.on('close', (code) => {
        cleanup();
        if (options.onLine) {
          try {
            for (const line of Object.values(partial)) if (line) options.onLine(line);
          } catch (error) {
            reason ??= error instanceof Error ? error : new Error(String(error));
          }
        }
        if (reason) {
          if (
            reason instanceof MusicDLError &&
            reason.code === 'TIMEOUT' &&
            (stderr || stdout).trim()
          ) {
            reason = new MusicDLError(
              `${reason.message} Recent tool output: ${redact(stderr || stdout).slice(-800)}`,
              reason.code,
              reason.retryable,
            );
          }
          reject(reason);
          return;
        }
        if (code !== 0) {
          const detail = redact(stderr || stdout)
            .slice(-2000)
            .trim();
          const restricted =
            /private|unavailable|not available|copyright|DRM|sign in|login required|403|404|unsupported URL|no video formats/i.test(
              detail,
            );
          reject(
            new MusicDLError(
              `Tool failed (${code ?? 'signal'}). ${detail || 'Run musicdl doctor to check dependencies.'}`,
              restricted ? 'UNAVAILABLE' : 'TOOL_FAILED',
              !restricted,
            ),
          );
        } else resolve({ stdout, stderr });
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      timeout = setTimeout(() => {
        if (!reason) {
          reason = new MusicDLError(
            'The provider timed out. Check your connection and retry.',
            'TIMEOUT',
            true,
          );
          kill();
        }
      }, options.timeoutMs ?? 180_000);
      timeout.unref();
    });
  }
}
