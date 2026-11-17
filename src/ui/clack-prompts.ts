import * as clack from '@clack/prompts';
import { isCancel } from '@clack/prompts';
import type { PromptPort, Choice } from '../prompts.js';
import { abortError, MusicDLError } from '../core/errors.js';
import { cleanText } from '../core/safety.js';
import { metadataStatus } from '../providers/spotify.js';
import type { MetadataProgress } from '../providers/spotify.js';
export class ClackPrompts implements PromptPort {
  private loading: ReturnType<typeof clack.spinner> | undefined;
  private lastProgressAt = 0;
  readonly interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  private require(): void {
    if (!this.interactive)
      throw new MusicDLError(
        'This action needs an interactive terminal. Use explicit CLI flags.',
        'INTERACTIVE_REQUIRED',
      );
  }
  async select(message: string, options: Choice[], initial?: string): Promise<string> {
    this.require();
    const result = await clack.select({
      message: cleanText(message),
      options: options.map((o) => ({
        value: o.value,
        label: cleanText(o.label),
        ...(o.hint ? { hint: cleanText(o.hint) } : {}),
      })),
      ...(initial ? { initialValue: initial } : {}),
    });
    if (isCancel(result)) throw abortError();
    return result;
  }
  async multiselect(message: string, options: Choice[], initial: string[] = []): Promise<string[]> {
    this.require();
    const result = await clack.multiselect({
      message: cleanText(message),
      options: options.map((o) => ({ value: o.value, label: cleanText(o.label) })),
      required: false,
      initialValues: initial,
    });
    if (isCancel(result)) throw abortError();
    return result;
  }
  async confirm(message: string, initial = false): Promise<boolean> {
    this.require();
    const result = await clack.confirm({ message: cleanText(message), initialValue: initial });
    if (isCancel(result)) return false;
    return result;
  }
  async text(message: string, initial = ''): Promise<string> {
    this.require();
    const result = await clack.text({ message: cleanText(message), initialValue: initial });
    if (isCancel(result)) throw abortError();
    return cleanText(result);
  }
  note(message: string): void {
    if (this.interactive) clack.note(message.split('\n').map(cleanText).join('\n'));
    else process.stdout.write(`${message.split('\n').map(cleanText).join('\n')}\n`);
  }
  progress(value: MetadataProgress | undefined): void {
    if (!value) {
      this.loading?.clear();
      this.loading = undefined;
      return;
    }
    const message = metadataStatus(value);
    if (!this.interactive) {
      if (
        value.stage === 'starting' ||
        ['complete', 'failed', 'cancelled'].includes(value.stage) ||
        Date.now() - this.lastProgressAt >= 5000
      ) {
        process.stderr.write(`${message}\n`);
        this.lastProgressAt = Date.now();
      }
      return;
    }
    if (!this.loading) {
      this.loading = clack.spinner({ output: process.stderr });
      this.loading.start(message);
    } else this.loading.message(message);
    if (value.stage === 'complete') {
      this.loading.stop(message);
      this.loading = undefined;
    } else if (value.stage === 'failed') {
      this.loading.error(message);
      this.loading = undefined;
    } else if (value.stage === 'cancelled') {
      this.loading.cancel(message);
      this.loading = undefined;
    }
  }
}
