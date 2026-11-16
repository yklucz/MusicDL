export class MusicDLError extends Error {
  constructor(
    message: string,
    readonly code = 'ERROR',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MusicDLError';
  }
}
export function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || (error instanceof MusicDLError && error.code === 'CANCELLED'))
  );
}
export function abortError(): MusicDLError {
  return new MusicDLError('Operation cancelled.', 'CANCELLED');
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
