import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { LibraryTrack, LocalPlaylist } from './core/types.js';
import { cleanText, expandPath } from './core/safety.js';
import { MusicDLError } from './core/errors.js';
import { Store } from './storage/store.js';
import type { Library } from './library.js';

export function parseM3u(text: string, base: string): { paths: string[]; rejected: string[] } {
  const paths: string[] = [],
    rejected: string[] = [],
    seen = new Set<string>();
  for (const raw of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (
      /[\u0000-\u001f\u007f]/.test(line) ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(line) ||
      /^sdmc:/i.test(line) ||
      /^\\\\/.test(line)
    ) {
      rejected.push(cleanText(line));
      continue;
    }
    const file = path.resolve(base, process.platform === 'win32' ? line : line.replace(/\\/g, '/'));
    const key = process.platform === 'linux' ? file : file.toLocaleLowerCase();
    if (!seen.has(key)) {
      paths.push(file);
      seen.add(key);
    }
  }
  return { paths, rejected };
}
export function renderM3u(
  tracks: LibraryTrack[],
  base: string,
  relative: boolean,
  pathFor?: (track: LibraryTrack) => string,
): string {
  const lines = ['#EXTM3U'];
  const seen = new Set<string>();
  for (const track of tracks) {
    if (seen.has(track.path)) continue;
    seen.add(track.path);
    const file = pathFor
      ? pathFor(track)
      : relative
        ? path.relative(base, track.path).split(path.sep).join('/')
        : track.path;
    if (/[\r\n\0]/.test(file) || file.startsWith('#'))
      throw new MusicDLError('A filename cannot safely be represented in M3U.', 'UNSAFE_PATH');
    lines.push(
      `#EXTINF:${Math.round(track.duration)},${cleanText(`${track.artist} - ${track.title}`)}`,
      file,
    );
  }
  return `${lines.join('\n')}\n`;
}
export class PlaylistManager {
  constructor(readonly store: Store) {}
  create(name: string): LocalPlaylist {
    return this.store.createPlaylist(this.name(name));
  }
  rename(id: string, name: string): void {
    this.require(id);
    this.store.renamePlaylist(id, this.name(name));
  }
  delete(id: string): void {
    this.require(id);
    this.store.deletePlaylist(id);
  }
  add(id: string, trackIds: string[]): void {
    this.require(id);
    for (const trackId of trackIds)
      if (!this.store.track(trackId))
        throw new MusicDLError(`Track not found: ${trackId}`, 'NOT_FOUND');
    this.store.setPlaylistTracks(id, [
      ...this.store.playlistTracks(id).map((t) => t.id),
      ...trackIds,
    ]);
  }
  remove(id: string, trackIds: string[]): void {
    this.require(id);
    const remove = new Set(trackIds);
    this.store.setPlaylistTracks(
      id,
      this.store
        .playlistTracks(id)
        .filter((t) => !remove.has(t.id))
        .map((t) => t.id),
    );
  }
  reorder(id: string, trackIds: string[]): void {
    this.require(id);
    const current = this.store.playlistTracks(id).map((t) => t.id);
    if (
      new Set(trackIds).size !== current.length ||
      !current.every((key) => trackIds.includes(key))
    )
      throw new MusicDLError('Reorder must contain each current track exactly once.', 'SELECTION');
    this.store.setPlaylistTracks(id, trackIds);
  }
  async export(id: string, file: string, relative = true): Promise<void> {
    this.require(id);
    const output = expandPath(file);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      renderM3u(this.store.playlistTracks(id), path.dirname(output), relative),
      { flag: 'wx', mode: 0o600 },
    );
  }
  async import(
    file: string,
    name: string,
    library: Library,
  ): Promise<{ playlist: LocalPlaylist; rejected: string[]; missing: string[] }> {
    const input = expandPath(file);
    const text = await readFile(input, 'utf8');
    if (Buffer.byteLength(text) > 10 * 1024 * 1024)
      throw new MusicDLError('Playlist exceeds 10 MB.', 'IMPORT_LIMIT');
    const parsed = parseM3u(text, path.dirname(input)),
      ids: string[] = [],
      missing: string[] = [];
    for (const location of parsed.paths) {
      try {
        ids.push((await library.index(location)).id);
      } catch {
        missing.push(location);
      }
    }
    const playlist = this.create(name);
    this.add(playlist.id, ids);
    return { playlist, rejected: parsed.rejected, missing };
  }
  require(idOrName: string): LocalPlaylist {
    const items = this.store
      .playlists()
      .filter((item) => item.id === idOrName || item.name === idOrName);
    if (items.length !== 1)
      throw new MusicDLError(
        items.length ? 'Playlist name is ambiguous. Use its ID.' : 'Playlist not found.',
        'NOT_FOUND',
      );
    return items[0]!;
  }
  private name(name: string): string {
    const result = cleanText(name).trim();
    if (!result || result.length > 200)
      throw new MusicDLError('Playlist name must contain 1–200 characters.', 'METADATA');
    return result;
  }
}
