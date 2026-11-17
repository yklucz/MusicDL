export interface Choice {
  value: string;
  label: string;
  hint?: string | undefined;
}
export interface PromptPort {
  interactive: boolean;
  select(message: string, options: Choice[], initial?: string): Promise<string>;
  multiselect(message: string, options: Choice[], initial?: string[]): Promise<string[]>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  text(message: string, initial?: string): Promise<string>;
  note(message: string): void;
  progress?: MetadataReporter;
}
import type { MetadataReporter } from './providers/spotify.js';
