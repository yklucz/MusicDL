import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Dashboard } from '../src/ui/dashboard.js';
import { MusicDL } from '../src/app.js';
import { Store } from '../src/storage/store.js';
import { defaults } from '../src/settings.js';
import type { Runner, RunResult } from '../src/core/process.js';

const apps: MusicDL[] = [];
afterEach(async () => {
  cleanup();
  for (const app of apps.splice(0)) await app.close();
});
const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 40));
};
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await tick();
  }
  expect(check()).toBe(true);
}
async function fixture(runner?: Runner): Promise<MusicDL> {
  const root = await mkdtemp(path.join(tmpdir(), 'musicdl-ui-'));
  const app = new MusicDL(
    defaults(root),
    {
      config: root,
      state: root,
      settings: path.join(root, 'config.json'),
      database: path.join(root, 'db.sqlite'),
      staging: path.join(root, 'staging'),
      lock: path.join(root, 'worker.lock'),
    },
    new Store(path.join(root, 'db.sqlite')),
    runner,
  );
  apps.push(app);
  return app;
}
describe('keyboard terminal interface', () => {
  it('preserves playlist membership and order when the track editor is confirmed unchanged', async () => {
    const app = await fixture();
    for (const id of ['a', 'b'])
      app.store.upsertTrack({
        id,
        path: `/music/${id}.mp3`,
        title: id.toUpperCase(),
        artist: 'Artist',
        album: '',
        duration: 1,
        codec: 'mp3',
        bitrate: 128,
        size: 1,
        mtime: 0,
      });
    const playlist = app.playlists.create('Ordered');
    app.playlists.add(playlist.id, ['b', 'a']);
    const ui = render(<Dashboard app={app} initialTab="Playlists" />);
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\x1b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(app.store.playlistTracks(playlist.id).map((track) => track.id)).toEqual(['b', 'a']);
  });
  it('starts with one universal field and navigates to a searchable library with Tab', async () => {
    const app = await fixture(),
      ui = render(<Dashboard app={app} />);
    await until(() => ui.lastFrame()?.includes('Paste a URL or search for music...') ?? false);
    expect(ui.lastFrame()).not.toContain('Download Song');
    for (let i = 0; i < 3; i++) {
      ui.stdin.write('\t');
      await tick();
    }
    expect(ui.lastFrame()).toContain('No indexed tracks');
    ui.stdin.write('/');
    await tick();
    ui.stdin.write('Bài hát');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Bài hát');
    ui.stdin.write('\x1b');
    await tick();
    expect(ui.lastFrame()).toContain('Paste a URL or search for music...');
  });
  it('asks the required mixed-link question with single-song as the default and supports cancellation', async () => {
    const runner: Runner = {
      run: async (): Promise<RunResult> => ({
        stdout: JSON.stringify({
          id: 'abcdefghijk',
          title: 'Authorized fixture',
          artist: 'Test',
          extractor_key: 'Youtube',
        }),
        stderr: '',
      }),
    };
    const app = await fixture(runner),
      ui = render(<Dashboard app={app} />);
    await tick();
    ui.stdin.write('https://youtube.com/watch?v=abcdefghijk&list=PL123');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Download this song only (default)') ?? false);
    expect(ui.lastFrame()).toContain('Download the entire playlist');
    expect(ui.lastFrame()).toContain('Select specific songs');
    ui.stdin.write('\x1b');
    await tick();
    expect(app.store.jobs()).toHaveLength(0);
  });
  it('creates a persistent playlist through keyboard prompts', async () => {
    const app = await fixture(),
      ui = render(<Dashboard app={app} initialTab="Playlists" />);
    await tick();
    ui.stdin.write('n');
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('Favorites');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(app.store.playlists().map((p) => p.name)).toEqual(['Favorites']);
    expect(ui.lastFrame()).toContain('Favorites');
  });
});
