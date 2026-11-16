import path from 'node:path';
import type { AudioFormat, LibraryTrack } from '../core/types.js';
export function matchesFormat(track: LibraryTrack, format: AudioFormat): boolean {
  const extension = path.extname(track.path).slice(1).toLowerCase();
  if (format === 'original') return false;
  if (format === 'm4a') return extension === 'm4a' && ['aac', 'alac'].includes(track.codec);
  return extension === format && track.codec === format;
}
