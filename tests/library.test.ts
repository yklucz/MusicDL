import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { PlaylistManager, parseM3u, renderM3u } from '../src/playlists.js';
import { planExport, executeExport } from '../src/devices/export.js';
import type { LibraryTrack } from '../src/core/types.js';

const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
function add(store: Store, id: string, file: string, codec = 'mp3'): LibraryTrack {
  return store.upsertTrack({
    id,
    path: file,
    title: `Title ${id}`,
    artist: 'Artist',
    album: 'Album',
    duration: 60,
    codec,
    bitrate: 128,
    size: 1,
    mtime: 0,
  });
}
describe('independent playlists', () => {
  it('parses relative and absolute M3U8 entries, deduplicates, preserves order and rejects remote entries', () => {
    expect(
      parseM3u(
        '\ufeff#EXTM3U\n#EXTINF:60,Song\n../one.mp3\n/other/two.mp3\n../one.mp3\nhttps://example.org/a.mp3\n',
        path.resolve('/music/lists'),
      ),
    ).toEqual({
      paths: [path.resolve('/music/one.mp3'), path.resolve('/other/two.mp3')],
      rejected: ['https://example.org/a.mp3'],
    });
  });
  it('exports ordered tracks without creating duplicate audio files', () => {
    const tracks: LibraryTrack[] = [
      {
        id: 'a',
        path: '/music/audio/a.mp3',
        title: 'Đêm',
        artist: 'Artist',
        album: '',
        duration: 65,
        codec: 'mp3',
        bitrate: 128,
        size: 1,
        mtime: 0,
      },
    ];
    expect(renderM3u(tracks, '/music/lists', true)).toBe(
      '#EXTM3U\n#EXTINF:65,Artist - Đêm\n../audio/a.mp3\n',
    );
    expect(renderM3u(tracks, '/music/lists', false)).toContain('/music/audio/a.mp3');
  });
  it('maintains playlist order across adding, removing, renaming and reopening the database', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'musicdl-playlist-'));
    const file = path.join(dir, 'db.sqlite');
    const store = new Store(file);
    stores.push(store);
    const manager = new PlaylistManager(store);
    add(store, 'a', '/music/a.mp3');
    add(store, 'b', '/music/b.mp3');
    const playlist = manager.create('Favorites');
    manager.add(playlist.id, ['b', 'a', 'b']);
    expect(store.playlistTracks(playlist.id).map((t) => t.id)).toEqual(['b', 'a']);
    manager.rename(playlist.id, 'Renamed');
    manager.remove(playlist.id, ['b']);
    expect(store.playlistTracks(playlist.id).map((t) => t.id)).toEqual(['a']);
    expect(store.playlists()[0]?.name).toBe('Renamed');
    manager.delete(playlist.id);
    expect(store.library()).toHaveLength(2);
  });
  it('refuses to overwrite an existing playlist export', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'musicdl-m3u-'));
    const store = new Store(':memory:');
    stores.push(store);
    const manager = new PlaylistManager(store),
      playlist = manager.create('Test');
    const file = path.join(dir, 'test.m3u8');
    await writeFile(file, 'mine');
    await expect(manager.export(playlist.id, file, true)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('mine');
  });
});
describe('optional device export', () => {
  it('plans Canary export with sdmc paths while leaving the source untouched', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'musicdl-canary-'));
    const source = path.join(dir, 'original.mp3');
    await writeFile(source, 'original');
    const store = new Store(':memory:');
    stores.push(store);
    const track = add(store, 'a', source);
    const destination = path.join(dir, 'sd');
    const plan = planExport([track], destination, { kind: 'canary3ds', playlistName: 'Favorites' });
    expect(plan.entries[0]?.destination).toBe(
      path.join(destination, 'Music', 'MusicDL', 'Title a - Artist.mp3'),
    );
    expect(plan.playlistPath).toBe(
      path.join(destination, '3ds', 'Canary', 'Playlists', 'Favorites.m3u'),
    );
    await executeExport(plan);
    expect(await readFile(plan.playlistPath!, 'utf8')).toContain(
      'sdmc:/Music/MusicDL/Title a - Artist.mp3',
    );
    expect(await readFile(source, 'utf8')).toBe('original');
  });
  it('rejects incompatible Canary audio and colliding destinations before writing', async () => {
    const store = new Store(':memory:');
    stores.push(store);
    expect(() =>
      planExport([add(store, 'a', '/music/a.flac', 'flac')], '/sd', { kind: 'canary3ds' }),
    ).toThrow('MP3');
    const first = add(store, 'b', '/music/b.mp3'),
      second = add(store, 'c', '/music/c.mp3');
    second.title = first.title;
    expect(() => planExport([first, second], '/sd', { kind: 'folder' })).toThrow('same');
  });
  it('does not replace a file that already exists on a device', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'musicdl-device-'));
    const source = path.join(dir, 'original.mp3');
    await writeFile(source, 'new');
    const store = new Store(':memory:');
    stores.push(store);
    const plan = planExport([add(store, 'a', source)], path.join(dir, 'export'), {
      kind: 'folder',
    });
    await mkdir(path.dirname(plan.entries[0]!.destination), { recursive: true });
    await writeFile(plan.entries[0]!.destination, 'existing');
    await expect(executeExport(plan)).rejects.toThrow('exist');
    expect(await readFile(plan.entries[0]!.destination, 'utf8')).toBe('existing');
  });
});
