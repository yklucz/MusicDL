import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rmdir, lstat } from 'node:fs/promises';
import type { Collection, CollectionDestination } from '../core/types.js';
import { safeSegment, contained } from '../core/safety.js';
import { MusicDLError } from '../core/errors.js';
import type { Store } from '../storage/store.js';

export function collectionKey(collection: Collection): string {
  const host = new URL(collection.url).hostname.toLowerCase();
  const provider = /^(www\.|music\.|m\.)?youtube\.com$/.test(host) ? 'youtube.com' : host;
  return createHash('sha256')
    .update(JSON.stringify([provider, collection.kind, collection.id]))
    .digest('hex');
}
export function collectionDirectory(destination: CollectionDestination): string {
  if (
    !path.isAbsolute(destination.root) ||
    !path.isAbsolute(destination.directory) ||
    !contained(destination.root, destination.directory) ||
    path.dirname(destination.directory) !== destination.root
  )
    throw new MusicDLError('Unsafe stored collection destination.', 'UNSAFE_PATH');
  return destination.directory;
}
export async function reserveCollectionFolder(
  store: Store,
  downloadsDir: string,
  collection: Collection,
): Promise<CollectionDestination> {
  const root = path.resolve(downloadsDir),
    key = collectionKey(collection);
  const previous = store.collectionDestination(key, root);
  if (previous) {
    collectionDirectory(previous);
    return previous;
  }
  await mkdir(root, { recursive: true });
  const title = safeSegment(collection.title);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix =
      attempt === 0 ? '' : ` [${key.slice(0, 8)}]${attempt === 1 ? '' : ` (${attempt})`}`;
    const directory = path.join(root, title + suffix);
    // Reserve case-insensitively even on Linux so exported libraries stay portable.
    const occupied = (await readdir(root)).some(
      (name) =>
        name.normalize('NFC').toLowerCase() ===
        path.basename(directory).normalize('NFC').toLowerCase(),
    );
    if (occupied) continue;
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const destination: CollectionDestination = {
      key,
      root,
      directory,
      title: collection.title,
      url: collection.url,
      kind: collection.kind,
    };
    try {
      const saved = store.reserveCollection(destination);
      if (saved.directory !== directory) await rmdir(directory).catch(() => {});
      return saved;
    } catch (error) {
      // Remove only the empty directory this call just created, never its files.
      if ((await lstat(directory)).isDirectory()) await rmdir(directory).catch(() => {});
      const raced = store.collectionDestination(key, root);
      if (raced) return raced;
      if ((error as Error).message.includes('UNIQUE constraint')) continue;
      throw error;
    }
  }
  throw new MusicDLError(
    'Could not reserve a distinct collection folder. Choose another downloads directory.',
    'EXISTS',
  );
}
