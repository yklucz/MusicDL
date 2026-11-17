import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useApp } from 'ink';
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
// Ink commits frames and input subscriptions asynchronously. Wait for its actual
// render barrier and the expected prompt instead of guessing a platform-dependent delay.
async function terminal(children: ReactNode) {
  let flush: (() => Promise<void>) | undefined;
  function Barrier(): React.JSX.Element {
    const app = useApp();
    useEffect(() => {
      flush = app.waitUntilRenderFlush;
    }, [app.waitUntilRenderFlush]);
    return <>{children}</>;
  }
  const ui = render(<Barrier />);
  const write = ui.stdout.write;
  ui.stdout.write = (frame: string, callback?: () => void): void => {
    if (frame) write(frame);
    callback?.();
  };
  await vi.waitFor(() => expect(flush).toBeDefined());
  await flush!();
  return {
    ...ui,
    async press(input: string) {
      await flush!();
      ui.stdin.write(input);
      await flush!();
    },
    async frame(value: string) {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain(value), {
        timeout: 5000,
        interval: 10,
      });
      await flush!();
    },
  };
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
    const ui = await terminal(<Dashboard app={app} initialTab="Playlists" />);
    await ui.frame('Ordered · 2 tracks');
    await ui.press('\r');
    await ui.frame('Create playlist');
    await ui.press('\x1b[B');
    await ui.press('\r');
    await ui.frame('Choose playlist tracks');
    await ui.press('\r');
    await ui.frame('2 selected');
    await ui.press('\r');
    await ui.frame('Ordered · 2 tracks');
    expect(app.store.playlistTracks(playlist.id).map((track) => track.id)).toEqual(['b', 'a']);
  });
  it('starts with one universal field and navigates to a searchable library with Tab', async () => {
    const app = await fixture(),
      ui = await terminal(<Dashboard app={app} />);
    await ui.frame('Paste a URL or search for music...');
    expect(ui.lastFrame()).not.toContain('Download Song');
    for (let i = 0; i < 3; i++) {
      await ui.press('\t');
    }
    expect(ui.lastFrame()).toContain('No indexed tracks');
    await ui.press('/');
    await ui.press('Bài hát');
    await ui.press('\r');
    expect(ui.lastFrame()).toContain('Bài hát');
    await ui.press('\x1b');
    await ui.frame('Paste a URL or search for music...');
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
      ui = await terminal(<Dashboard app={app} />);
    await ui.press('https://youtube.com/watch?v=abcdefghijk&list=PL123');
    await ui.press('\r');
    await ui.frame('Download this song only (default)');
    expect(ui.lastFrame()).toContain('Download the entire playlist');
    expect(ui.lastFrame()).toContain('Select specific songs');
    await ui.press('\x1b');
    await ui.frame('Paste a URL or search for music...');
    expect(app.store.jobs()).toHaveLength(0);
  });
  it('creates a persistent playlist through keyboard prompts', async () => {
    const app = await fixture(),
      ui = await terminal(<Dashboard app={app} initialTab="Playlists" />);
    await ui.press('n');
    await ui.frame('Create playlist');
    await ui.press('\r');
    await ui.frame('Playlist name');
    await ui.press('Favorites');
    await ui.frame('Favorites');
    await ui.press('\r');
    await vi.waitFor(() => expect(app.store.playlists().map((p) => p.name)).toEqual(['Favorites']));
    await ui.frame('Created Favorites.');
    expect(ui.lastFrame()).toContain('Favorites');
  });
});
