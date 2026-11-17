import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/storage/store.js';
import { DownloadManager } from '../src/downloads/manager.js';
import type { DownloadPipeline } from '../src/downloads/manager.js';
import type { AudioFormat, Collection, Track } from '../src/core/types.js';
import { defaults, loadSettings } from '../src/settings.js';
import { MusicDL } from '../src/app.js';
import type { PromptPort } from '../src/prompts.js';
import type { Runner } from '../src/core/process.js';
import { DatabaseSync } from 'node:sqlite';

const stores: Store[] = [],
  managers: DownloadManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  for (const store of stores.splice(0)) store.close();
});
const song = (id = 'abcdefghijk'): Track => ({
  key: `youtube:${id}`,
  provider: 'youtube',
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  url: `https://www.youtube.com/watch?v=${id}`,
  confidence: 'provider',
});
const collection = (
  id: string,
  title = 'Chill Music',
  url = `https://www.youtube.com/playlist?list=${id}`,
): Collection => ({
  id,
  title,
  url,
  kind: 'playlist',
  tracks: [song()],
  totalCount: 1,
  unavailableCount: 0,
});
async function fixture(extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'musicdl-collections-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  stores.push(store);
  const config = { ...defaults(root), downloadsDir: path.join(root, 'Downloads'), ...extra };
  let downloads = 0;
  const pipeline: DownloadPipeline = async (job, staging, signal) => {
    signal.throwIfAborted();
    downloads++;
    const extension = job.format === 'original' ? 'opus' : job.format;
    const file = path.join(staging, `audio.${extension}`);
    await writeFile(file, `authorized fixture ${job.track.key}`);
    return {
      file,
      extension,
      info: {
        duration: 1,
        codec: job.format === 'm4a' ? 'aac' : extension,
        bitrate: 128,
        tags: {},
        hasArtwork: true,
      },
    };
  };
  const manager = new DownloadManager(store, config, pipeline, root);
  managers.push(manager);
  return { root, store, config, manager, pipeline, downloads: () => downloads };
}
async function finish(manager: DownloadManager) {
  await manager.start();
  await manager.drain();
  await manager.stop();
}

describe('persistent online collection folders', () => {
  it('adds collection persistence to a version-three database without losing jobs or history', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'musicdl-v3-')),
      file = path.join(root, 'old.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY,track_key TEXT NOT NULL,track_json TEXT NOT NULL,format TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL DEFAULT 0,error TEXT,output_path TEXT,file_hash TEXT,batch_id TEXT,progress_json TEXT,audio_info_json TEXT);
      CREATE UNIQUE INDEX jobs_active_unique ON jobs(track_key,format) WHERE status IN ('queued','downloading','processing','retrying');
      CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,created_at INTEGER NOT NULL);
      INSERT INTO history VALUES(1,'legacy','Original title','completed','Keep history',123); PRAGMA user_version=3;`);
    legacy
      .prepare(
        'INSERT INTO jobs(id,track_key,track_json,format,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        '00000000-0000-0000-0000-000000000001',
        song().key,
        JSON.stringify(song()),
        'mp3',
        'queued',
        1,
        1,
      );
    legacy.close();
    const store = new Store(file);
    stores.push(store);
    expect(store.jobs()).toHaveLength(1);
    expect(store.jobs()[0]?.destination).toBeUndefined();
    expect(store.jobs()[0]?.track.title).toBe('Song abcdefghijk');
    expect(store.history()[0]).toMatchObject({
      title: 'Original title',
      message: 'Keep history',
      createdAt: 123,
    });
    const f = await fixture();
    const manager = new DownloadManager(store, f.config, f.pipeline, root);
    managers.push(manager);
    expect((await manager.enqueue([song()], 'mp3', undefined, collection('A'))).added).toHaveLength(
      1,
    );
    expect(store.jobs()).toHaveLength(2);
  });
  it.each([
    ['spotify', 'https://open.spotify.com/playlist/abcdefghijklmnopqrstuv', 'mp3'],
    ['youtube', 'https://www.youtube.com/playlist?list=PL_A', 'm4a'],
    ['youtube-music', 'https://music.youtube.com/playlist?list=PL_A', 'opus'],
    ['album', 'https://open.spotify.com/album/abcdefghijklmnopqrstuv', 'flac'],
    ['original', 'https://music.youtube.com/playlist?list=PL_B', 'original'],
  ])(
    'puts %s collection tracks directly inside the provider title folder',
    async (_provider, url, format) => {
      const f = await fixture({ structure: 'artist-album' });
      const source = {
        ...collection('source', 'NEWWAVE', url!),
        kind: url!.includes('/album/') ? ('album' as const) : ('playlist' as const),
      };
      await f.manager.enqueue([song()], format as AudioFormat, undefined, source);
      await finish(f.manager);
      const extension = format === 'original' ? 'opus' : format;
      expect(f.store.jobs()[0]?.outputPath).toBe(
        path.join(f.config.downloadsDir, 'NEWWAVE', `Song abcdefghijk - Artist.${extension}`),
      );
      expect(f.store.jobs()[0]?.status).toBe('completed');
      expect(await readFile(f.store.jobs()[0]!.outputPath!, 'utf8')).toBe(
        'authorized fixture youtube:abcdefghijk',
      );
    },
  );
  it.each([
    ['Đêm / Chill: 你好?', 'Đêm _ Chill_ 你好_'],
    ['../../outside', '_outside'],
    ['CON', '_CON'],
    ['A\u0301lbum', 'Álbum'],
  ])('sanitizes %s while preserving Unicode', async (title, expected) => {
    const f = await fixture();
    const result = await f.manager.enqueue([song()], 'mp3', undefined, collection('A', title));
    expect(result.added[0]?.destination?.directory).toBe(
      path.join(f.config.downloadsDir, expected!),
    );
  });
  it('separates unrelated same-name collections but reuses the original collection reservation', async () => {
    const f = await fixture();
    const a = await f.manager.enqueue([song()], 'mp3', undefined, collection('A'));
    const b = await f.manager.enqueue([song()], 'mp3', undefined, collection('B'));
    expect(a.added).toHaveLength(1);
    expect(b.added).toHaveLength(1);
    expect(path.basename(a.added[0]!.destination!.directory)).toBe('Chill Music');
    expect(path.basename(b.added[0]!.destination!.directory)).toMatch(
      /^Chill Music \[[a-f0-9]{8}\]$/,
    );
    const again = await f.manager.enqueue(
      [song('lmnopqrstuv')],
      'mp3',
      undefined,
      collection('A', 'Renamed online'),
    );
    expect(again.added[0]?.destination?.directory).toBe(a.added[0]?.destination?.directory);
  });
  it('keeps occupied unowned folders intact instead of merging into them', async () => {
    const f = await fixture();
    const occupied = path.join(f.config.downloadsDir, 'Chill Music');
    await mkdir(occupied, { recursive: true });
    await writeFile(path.join(occupied, 'personal.txt'), 'keep');
    await f.manager.enqueue([song()], 'mp3', undefined, collection('A'));
    await finish(f.manager);
    expect(path.dirname(f.store.jobs()[0]!.outputPath!)).not.toBe(occupied);
    expect(await readdir(occupied)).toEqual(['personal.txt']);
    expect(await readFile(path.join(occupied, 'personal.txt'), 'utf8')).toBe('keep');
  });
  it('never replaces an occupied music filename in a reserved collection folder', async () => {
    const f = await fixture();
    const queued = await f.manager.enqueue([song()], 'mp3', undefined, collection('A'));
    const output = path.join(
      queued.added[0]!.destination!.directory,
      'Song abcdefghijk - Artist.mp3',
    );
    await writeFile(output, 'existing personal music');
    await finish(f.manager);
    expect(f.store.jobs()[0]?.status).toBe('failed');
    expect(f.store.jobs()[0]?.error).toContain('already exists');
    expect(await readFile(output, 'utf8')).toBe('existing personal music');
  });
  it('reserves case-equivalent folder names separately across concurrent requests', async () => {
    const f = await fixture();
    const requests = await Promise.all([
      f.manager.enqueue([song()], 'mp3', undefined, collection('A', 'Mix')),
      f.manager.enqueue([song()], 'mp3', undefined, collection('B', 'mix')),
    ]);
    expect(
      new Set(requests.map((request) => request.added[0]!.destination!.directory.toLowerCase()))
        .size,
    ).toBe(2);
  });
  it('downloads only the selected subset inside its collection folder', async () => {
    const f = await fixture();
    const source = { ...collection('A'), tracks: [song(), song('lmnopqrstuv')], totalCount: 2 };
    await f.manager.enqueue([source.tracks[1]!], 'mp3', undefined, source);
    await finish(f.manager);
    expect(await readdir(path.join(f.config.downloadsDir, 'Chill Music'))).toEqual([
      'Song lmnopqrstuv - Artist.mp3',
    ]);
  });
  it('copies shared recordings into concurrent playlists without omitting requests or re-encoding', async () => {
    const f = await fixture({ concurrency: 3 });
    await f.manager.enqueue(
      [song(), song('lmnopqrstuv')],
      'mp3',
      undefined,
      collection('A', 'First'),
    );
    await f.manager.enqueue(
      [song(), song('xyzabcdefgh')],
      'mp3',
      undefined,
      collection('B', 'Second'),
    );
    await finish(f.manager);
    expect(f.store.jobs().map((j) => j.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(f.downloads()).toBe(3);
    expect(
      await readFile(path.join(f.config.downloadsDir, 'First', 'Song abcdefghijk - Artist.mp3')),
    ).toEqual(
      await readFile(path.join(f.config.downloadsDir, 'Second', 'Song abcdefghijk - Artist.mp3')),
    );
    expect(f.store.library()).toHaveLength(4);
  });
  it('copies an existing compatible library file into the requested folder and leaves its original intact', async () => {
    const f = await fixture();
    await f.manager.enqueue([song()], 'mp3');
    await finish(f.manager);
    const original = f.store.jobs()[0]!.outputPath!,
      before = await readFile(original);
    const request = await f.manager.enqueue([song()], 'mp3', undefined, collection('A'));
    expect(request.added).toHaveLength(1);
    expect(request.skipped).toHaveLength(0);
    await finish(f.manager);
    expect(f.downloads()).toBe(1);
    expect(await readFile(original)).toEqual(before);
    expect(
      await readFile(
        path.join(f.config.downloadsDir, 'Chill Music', 'Song abcdefghijk - Artist.mp3'),
      ),
    ).toEqual(before);
  });
  it('recovers interrupted jobs into their saved folder after restart and settings changes', async () => {
    const f = await fixture();
    const queued = await f.manager.enqueue([song()], 'mp3', undefined, collection('A', 'Saved'));
    f.store.updateJob(queued.added[0]!.id, { status: 'downloading', attempts: 1 });
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();
    const reopened = new Store(path.join(f.root, 'db.sqlite'));
    stores.push(reopened);
    const changed = {
      ...f.config,
      downloadsDir: path.join(f.root, 'Changed'),
      playlistFolders: false,
    };
    const resumed = new DownloadManager(reopened, changed, f.pipeline, f.root);
    managers.push(resumed);
    await finish(resumed);
    expect(reopened.jobs()[0]?.outputPath).toBe(
      path.join(f.config.downloadsDir, 'Saved', 'Song abcdefghijk - Artist.mp3'),
    );
    expect(reopened.jobs()[0]?.status).toBe('completed');
  });
  it('retains standalone and flat-download behavior when collection folders are disabled', async () => {
    const f = await fixture({ playlistFolders: false });
    await f.manager.enqueue([song()], 'mp3', undefined, collection('A'));
    await finish(f.manager);
    expect(f.store.jobs()[0]?.destination).toBeUndefined();
    expect(f.store.jobs()[0]?.outputPath).toBe(
      path.join(f.config.downloadsDir, 'Song abcdefghijk - Artist.mp3'),
    );
    expect(
      (await f.manager.enqueue([song()], 'mp3', undefined, collection('B'))).skipped,
    ).toHaveLength(1);
  });
  it('writes optional local playlists with references to the correct destination copies', async () => {
    const f = await fixture();
    for (const name of ['One', 'Two']) {
      const result = await f.manager.enqueue([song()], 'mp3', undefined, collection(name, name));
      f.store.createDownloadPlaylist(
        name,
        [song()],
        path.join(result.destination!.directory, `${name}.m3u8`),
        'mp3',
        result.destination,
      );
    }
    await finish(f.manager);
    for (const name of ['One', 'Two']) {
      const list = await readFile(path.join(f.config.downloadsDir, name, `${name}.m3u8`), 'utf8');
      expect(list).toContain('\nSong abcdefghijk - Artist.mp3\n');
      expect(list).not.toContain('../');
      const batch = f.store.downloadPlaylists().find((batch) => batch.name === name)!;
      expect(f.store.playlistTracks(batch.playlistId)[0]?.path).toBe(
        path.join(f.config.downloadsDir, name, 'Song abcdefghijk - Artist.mp3'),
      );
    }
  });
  it('waits for a queued equivalent recording before exporting a collection playlist', async () => {
    const f = await fixture();
    const first = { ...song(), isrc: 'US1234567890' },
      equivalent = { ...song('lmnopqrstuv'), isrc: 'us1234567890' };
    const request = await f.manager.enqueue([first], 'mp3', undefined, collection('A'));
    const destination = request.destination!;
    f.store.createDownloadPlaylist(
      'Equivalent',
      [equivalent],
      path.join(destination.directory, 'Equivalent.m3u8'),
      'mp3',
      destination,
    );
    await f.manager.syncPlaylists();
    expect(f.store.downloadPlaylists()[0]?.status).toBe('pending');
    await finish(f.manager);
    expect(await readFile(path.join(destination.directory, 'Equivalent.m3u8'), 'utf8')).toContain(
      '\nSong abcdefghijk - Artist.mp3\n',
    );
  });
  it('enables folders for older settings without rewriting the configuration file', async () => {
    const f = await fixture();
    const original = { ...defaults(f.root) } as Record<string, unknown>;
    delete original.playlistFolders;
    const file = path.join(f.root, 'config.json'),
      text = JSON.stringify(original);
    await writeFile(file, text);
    const config = await loadSettings({
      config: f.root,
      state: f.root,
      settings: file,
      database: '',
      staging: '',
      lock: '',
    });
    expect(config.playlistFolders).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(text);
  });
});

const providerSong = {
  id: 'abcdefghijk',
  title: 'Song',
  artist: 'Artist',
  webpage_url: 'https://www.youtube.com/watch?v=abcdefghijk',
  extractor: 'youtube',
};
const prompts = (choice: string): PromptPort => ({
  interactive: true,
  select: async () => choice,
  multiselect: async () => ['youtube:lmnopqrstuv'],
  confirm: async () => false,
  text: async (_, initial) => initial ?? '',
  note: () => {},
});
async function appFixture() {
  const f = await fixture();
  const runner: Runner = {
    run: async (_command, args) => {
      if (args.includes('--output')) {
        await writeFile(
          args[args.indexOf('--output') + 1]!,
          JSON.stringify({
            schema: 'musicdl-spotify-playlist-v1',
            complete: true,
            total: 1,
            name: 'Spotify Đêm',
            creator: 'Creator',
            entries: [
              {
                itemV2: {
                  data: {
                    __typename: 'Track',
                    uri: 'spotify:track:abcdefghijklmnopqrstuv',
                    name: 'Spotify Song',
                    artists: { items: [{ profile: { name: 'Artist' } }] },
                    albumOfTrack: { name: 'Release' },
                    trackDuration: { totalMilliseconds: 1000 },
                  },
                },
              },
            ],
          }),
        );
        return { stdout: 'MUSICDL_META PAGE 1/1\n', stderr: '' };
      }
      const url = args.at(-1)!,
        id = new URL(url).searchParams.get('list') ?? 'A';
      return {
        stdout: JSON.stringify(
          args.includes('--yes-playlist')
            ? {
                id,
                title: id === 'B' ? 'Second' : 'First',
                entries: [
                  providerSong,
                  {
                    ...providerSong,
                    id: 'lmnopqrstuv',
                    title: 'Other',
                    webpage_url: 'https://www.youtube.com/watch?v=lmnopqrstuv',
                  },
                ],
                playlist_count: 2,
              }
            : providerSong,
        ),
        stderr: '',
      };
    },
  };
  const app = new MusicDL(
    f.config,
    {
      config: f.root,
      state: f.root,
      settings: path.join(f.root, 'config.json'),
      database: path.join(f.root, 'db.sqlite'),
      staging: path.join(f.root, 'staging'),
      lock: path.join(f.root, 'worker.lock'),
    },
    f.store,
    runner,
  );
  return { ...f, app };
}
describe('collection selection destination integration', () => {
  it('uses Spotify provider title metadata for the persisted playlist destination', async () => {
    const { app, store, root } = await appFixture();
    const spotdl = path.join(root, process.platform === 'win32' ? 'spotdl.exe' : 'spotdl');
    await writeFile(spotdl, '');
    await writeFile(path.join(root, process.platform === 'win32' ? 'python.exe' : 'python'), '');
    app.config.tools.spotdl = spotdl;
    await app.downloadInput(
      'https://open.spotify.com/playlist/abcdefghijklmnopqrstuv',
      { yes: true },
      prompts('all'),
    );
    expect(store.jobs()).toHaveLength(1);
    expect(store.jobs()[0]?.track.provider).toBe('spotify');
    expect(path.basename(store.jobs()[0]!.destination!.directory)).toBe('Spotify Đêm');
  });
  it('keeps one video from a playlist standalone', async () => {
    const { app, store } = await appFixture();
    await app.downloadInput(
      'https://www.youtube.com/watch?v=abcdefghijk&list=A',
      {},
      prompts('single'),
    );
    expect(store.jobs()).toHaveLength(1);
    expect(store.jobs()[0]?.destination).toBeUndefined();
  });
  it('keeps a chosen subset in its source playlist folder', async () => {
    const { app, store } = await appFixture();
    await app.downloadInput('https://www.youtube.com/playlist?list=A', {}, prompts('select'));
    expect(store.jobs()).toHaveLength(1);
    expect(store.jobs()[0]?.track.id).toBe('lmnopqrstuv');
    expect(path.basename(store.jobs()[0]!.destination!.directory)).toBe('First');
  });
  it('organizes a single selected YouTube Music playlist member as a collection request', async () => {
    const { app, store } = await appFixture();
    await app.downloadInput(
      'https://music.youtube.com/watch?v=abcdefghijk&list=A',
      {},
      prompts('select'),
    );
    expect(store.jobs()).toHaveLength(1);
    expect(store.jobs()[0]?.track.id).toBe('lmnopqrstuv');
    expect(path.basename(store.jobs()[0]!.destination!.directory)).toBe('First');
  });
  it('retains both collection destinations when several playlists share tracks in one paste', async () => {
    const { app, store } = await appFixture();
    const result = await app.downloadInput(
      'https://www.youtube.com/playlist?list=A https://www.youtube.com/playlist?list=B',
      { yes: true },
      prompts('all'),
    );
    expect(result.added).toBe(4);
    expect(
      store
        .jobs()
        .filter((j) => j.track.id === 'abcdefghijk')
        .map((j) => path.basename(j.destination!.directory))
        .sort(),
    ).toEqual(['First', 'Second']);
  });
});
