import * as clack from '@clack/prompts';
import { isCancel } from '@clack/prompts';
import type { PromptPort, Choice } from '../prompts.js';
import { abortError, MusicDLError } from '../core/errors.js';
import { cleanText } from '../core/safety.js';
export class ClackPrompts implements PromptPort {
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
}
