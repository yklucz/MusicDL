import { EventEmitter } from 'node:events';
import type { Choice, PromptPort } from '../prompts.js';
import { abortError } from '../core/errors.js';
export interface PromptRequest {
  kind: 'select' | 'multiselect' | 'confirm' | 'text';
  message: string;
  options: Choice[];
  initial: string;
  initialSelected: string[];
  resolve: (value: string | string[] | boolean) => void;
  reject: (error: Error) => void;
}
export class PromptBroker extends EventEmitter implements PromptPort {
  readonly interactive = true;
  private current: PromptRequest | undefined;
  private ask(
    kind: PromptRequest['kind'],
    message: string,
    options: Choice[] = [],
    initial = '',
    initialSelected: string[] = [],
  ): Promise<string | string[] | boolean> {
    return new Promise((resolve, reject) => {
      this.current = {
        kind,
        message,
        options,
        initial,
        initialSelected,
        resolve: (value) => {
          this.current = undefined;
          this.emit('request', undefined);
          resolve(value);
        },
        reject,
      };
      this.emit('request', this.current);
    });
  }
  async select(message: string, options: Choice[], initial = ''): Promise<string> {
    return (await this.ask('select', message, options, initial)) as string;
  }
  async multiselect(message: string, options: Choice[], initial: string[] = []): Promise<string[]> {
    return (await this.ask('multiselect', message, options, '', initial)) as string[];
  }
  async confirm(message: string, initial = false): Promise<boolean> {
    return (await this.ask(
      'confirm',
      message,
      [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
      initial ? 'yes' : 'no',
    )) as boolean;
  }
  async text(message: string, initial = ''): Promise<string> {
    return (await this.ask('text', message, [], initial)) as string;
  }
  note(message: string): void {
    this.emit('note', message);
  }
  cancel(): void {
    this.current?.reject(abortError());
    this.current = undefined;
    this.emit('request', undefined);
  }
}
