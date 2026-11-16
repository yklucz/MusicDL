import type { Runner } from './core/process.js';
import type { Settings } from './settings.js';
import { errorMessage } from './core/errors.js';
import { redact } from './core/safety.js';
export interface Diagnostic {
  name: string;
  ok: boolean;
  detail: string;
}
export async function doctor(runner: Runner, config: Settings): Promise<Diagnostic[]> {
  const tasks = Object.entries(config.tools).map(async ([name, command]): Promise<Diagnostic> => {
    try {
      const version = await runner.run(
        command,
        [name === 'ffmpeg' || name === 'ffprobe' ? '-version' : '--version'],
        { timeoutMs: 30_000, maxOutput: 1024 * 1024 },
      );
      if (name === 'ytdlp' || name === 'spotdl') {
        const help = await runner.run(command, ['--help'], {
          timeoutMs: 30_000,
          maxOutput: 1024 * 1024,
        });
        const required =
          name === 'ytdlp'
            ? [
                '--no-playlist',
                '--yes-playlist',
                '--dump-single-json',
                '--flat-playlist',
                '--progress-template',
                '--no-overwrites',
                '--ignore-config',
                '--js-runtimes',
              ]
            : ['--save-file', '--bitrate', '--overwrite', '--output', '--format'];
        const missing = required.filter((flag) => !help.stdout.includes(flag));
        if (missing.length)
          return { name, ok: false, detail: `Update required; missing ${missing.join(', ')}` };
      }
      if (name === 'ffmpeg') {
        const encoders = await runner.run(command, ['-hide_banner', '-encoders'], {
          timeoutMs: 30_000,
        });
        const missing = ['libmp3lame', 'libopus', 'aac', 'flac'].filter(
          (encoder) => !encoders.stdout.includes(encoder),
        );
        if (missing.length)
          return { name, ok: false, detail: `Missing audio encoders: ${missing.join(', ')}` };
      }
      return {
        name,
        ok: true,
        detail: (version.stdout || version.stderr).split('\n')[0] ?? 'Available',
      };
    } catch (error) {
      return { name, ok: false, detail: redact(errorMessage(error)) };
    }
  });
  return Promise.all(tasks);
}
