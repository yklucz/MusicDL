import path from 'node:path';
import { homedir } from 'node:os';
import { lstat, mkdir, realpath, link, unlink, copyFile, constants } from 'node:fs/promises';
import { MusicDLError } from './errors.js';

export function cleanText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .normalize('NFC');
}
export function redact(value: string): string {
  return cleanText(
    value.replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:[^\r\n]*/gi,
      '$1: [redacted]',
    ),
  )
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        const identity = /^(?:(?:www|music|m)\.)?youtube\.com$/.test(url.hostname)
          ? [...url.searchParams].filter(([key, value]) =>
              key === 'v'
                ? /^[\w-]{11}$/.test(value)
                : key === 'list'
                  ? /^[\w-]{1,200}$/.test(value)
                  : ['index', 'start', 'end'].includes(key) && /^\d{1,8}$/.test(value),
            )
          : [];
        url.search = '';
        for (const [key, value] of identity) url.searchParams.append(key, value);
        url.hash = '';
        return url.toString();
      } catch {
        return '[URL]';
      }
    })
    .replace(
      /\b(authorization|cookie|(?:access[_-]|refresh[_-])?token|password|client[_-]?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    );
}
export function validateUrl(input: string, allowLocal = false): URL {
  if (input.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(input))
    throw new MusicDLError('Enter a valid HTTP or HTTPS URL.', 'INVALID_URL');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new MusicDLError('Enter a valid HTTP or HTTPS URL.', 'INVALID_URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname)
    throw new MusicDLError(
      'Only HTTP(S) URLs without embedded credentials are accepted.',
      'INVALID_URL',
    );
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !allowLocal &&
    (/^(localhost|.*\.localhost|.*\.local)$/.test(host) ||
      /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      host === '::1' ||
      host === '::' ||
      /^(fc|fd|fe80|::ffff:)/i.test(host))
  ) {
    throw new MusicDLError(
      'Local/private URLs are disabled. Enable allowLocalUrls for trusted personal sources.',
      'INVALID_URL',
    );
  }
  url.hash = '';
  return url;
}
export function safeSegment(value: string): string {
  let segment = cleanText(value)
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .trim();
  if (!segment) segment = 'Unknown';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) segment = `_${segment}`;
  // Limit by UTF-8 bytes, never split a Unicode code point.
  let out = '';
  for (const char of segment) {
    if (Buffer.byteLength(out + char) > 180) break;
    out += char;
  }
  return out;
}
export function expandPath(value: string): string {
  return path.resolve(
    value === '~'
      ? homedir()
      : value.startsWith('~/') || value.startsWith('~\\')
        ? path.join(homedir(), value.slice(2))
        : value,
  );
}
export function contained(root: string, destination: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(destination));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export async function ensureSafeParent(root: string, destination: string): Promise<void> {
  if (!contained(root, destination))
    throw new MusicDLError('Destination escapes the configured directory.', 'UNSAFE_PATH');
  await mkdir(root, { recursive: true });
  let current = path.resolve(root);
  const base = await realpath(root);
  const parts = path.relative(current, path.dirname(destination)).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    await mkdir(current).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !contained(base, await realpath(current)))
      throw new MusicDLError('A destination directory contains an unsafe symlink.', 'UNSAFE_PATH');
  }
}
export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
export async function publishExclusive(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'EXDEV' ||
      (error as NodeJS.ErrnoException).code === 'EPERM' ||
      (error as NodeJS.ErrnoException).code === 'ENOTSUP'
    ) {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } else throw error;
  }
  await unlink(source);
}
