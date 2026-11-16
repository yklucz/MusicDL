import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, usePaste, useWindowSize, render } from 'ink';
import TextInput from 'ink-text-input';
import type { MusicDL } from '../app.js';
import type { Job, LibraryTrack } from '../core/types.js';
import { errorMessage, isAbort } from '../core/errors.js';
import { cleanText } from '../core/safety.js';
import { PromptBroker } from './prompt-broker.js';
import type { PromptRequest } from './prompt-broker.js';
import { doctor } from '../doctor.js';

const tabs = ['Home', 'Active', 'Queue', 'Library', 'Playlists', 'History', 'Settings'] as const;
type Tab = (typeof tabs)[number];
const themes = {
  aurora: { accent: '#72E4C4', muted: '#8795AD', border: '#3A495C' },
  amber: { accent: '#F7BF62', muted: '#B1A393', border: '#65543E' },
  mono: { accent: 'white', muted: 'gray', border: 'gray' },
};
const safe = (text: string): string => cleanText(text);
function time(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}
function progress(job: Job): string {
  const p = job.progress;
  if (!p) return job.status;
  const percent = p.percent === undefined ? '···' : `${p.percent.toFixed(0)}%`;
  const bars = p.percent === undefined ? 0 : Math.round(p.percent / 10);
  return `${'━'.repeat(bars)}${'─'.repeat(10 - bars)} ${percent}${p.speed ? ` · ${(p.speed / 1024 / 1024).toFixed(1)} MB/s` : ''}${p.eta !== undefined ? ` · ETA ${time(p.eta)}` : ''} · ${p.stage}`;
}
export function Dashboard({
  app,
  initialTab = 'Home',
}: {
  app: MusicDL;
  initialTab?: Tab;
}): React.JSX.Element {
  const { exit } = useApp(),
    windowSize = useWindowSize();
  const [tab, setTab] = useState<Tab>(initialTab),
    [input, setInput] = useState(''),
    [cursor, setCursor] = useState(0);
  const [, redraw] = useState(0),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(
      'Ready. Paste a URL, several URLs, or a song title and artist.',
    );
  const [modal, setModal] = useState<PromptRequest>(),
    [filter, setFilter] = useState(''),
    [filtering, setFiltering] = useState(false);
  const broker = useMemo(() => new PromptBroker(), []),
    closing = useRef(false),
    workRef = useRef<Promise<void> | undefined>(undefined);
  const colors = themes[app.config.theme],
    width = Math.max(32, windowSize.columns - 6),
    rows = Math.max(3, Math.min(16, windowSize.rows - 15));
  const jobs = app.store.jobs(),
    library = app.store.library(filter),
    playlists = app.store.playlists(),
    history = app.store.history(100);
  const active = jobs.filter((j) => ['downloading', 'processing'].includes(j.status)),
    queued = jobs.filter((j) => ['queued', 'retrying', 'failed', 'cancelled'].includes(j.status));
  const list =
    tab === 'Active'
      ? active
      : tab === 'Queue'
        ? queued
        : tab === 'Library'
          ? library
          : tab === 'Playlists'
            ? playlists
            : tab === 'History'
              ? history
              : [];
  const selected = Math.min(cursor, Math.max(0, list.length - 1)),
    start = Math.max(0, selected - rows + 1);
  const work = useCallback((task: () => Promise<void>): void => {
    if (closing.current) return;
    setBusy(true);
    const promise = task()
      .catch((error) => {
        if (!closing.current && !isAbort(error)) setMessage(errorMessage(error));
      })
      .finally(() => {
        if (!closing.current) setBusy(false);
      });
    workRef.current = promise;
  }, []);
  useEffect(() => {
    const update = (): void => redraw((value) => value + 1),
      request = (value?: PromptRequest): void => setModal(value),
      note = (value: string): void => setMessage(value);
    app.manager.on('change', update);
    broker.on('request', request);
    broker.on('note', note);
    const timer = setInterval(update, 500);
    void app.manager.start().catch((error) => setMessage(errorMessage(error)));
    return () => {
      clearInterval(timer);
      app.manager.off('change', update);
      broker.off('request', request);
      broker.off('note', note);
      broker.cancel();
    };
  }, [app, broker]);
  const quit = (): void => {
    if (closing.current) return;
    closing.current = true;
    broker.cancel();
    app.operations.abort();
    void (async () => {
      await workRef.current;
      await app.manager.stop();
      exit();
    })();
  };
  const submit = (value: string): void => {
    if (!value.trim() || busy) return;
    setInput('');
    work(async () => {
      await app.downloadInput(value, {}, broker);
    });
  };
  const playlistAction = async (): Promise<void> => {
    const choice = await broker.select('Playlists', [
      { value: 'new', label: 'Create playlist' },
      { value: 'manage', label: 'Manage selected playlist' },
      { value: 'import', label: 'Import M3U / M3U8' },
    ]);
    if (choice === 'new') {
      const playlist = app.playlists.create(await broker.text('Playlist name'));
      setMessage(`Created ${playlist.name}.`);
    } else if (choice === 'import') {
      const file = await broker.text('M3U8 file path');
      const name = await broker.text('Playlist name');
      const result = await app.playlists.import(file, name, app.library);
      setMessage(
        `Imported ${result.playlist.name}; ${result.missing.length} missing, ${result.rejected.length} rejected entries.`,
      );
    } else {
      const playlist = playlists[selected];
      if (!playlist) return;
      const action = await broker.select(playlist.name, [
        { value: 'tracks', label: 'Choose playlist tracks' },
        { value: 'rename', label: 'Rename' },
        { value: 'export', label: 'Export M3U8' },
        { value: 'delete', label: 'Delete playlist' },
      ]);
      if (action === 'rename')
        app.playlists.rename(playlist.id, await broker.text('New name', playlist.name));
      if (
        action === 'delete' &&
        (await broker.confirm(`Delete “${playlist.name}”? Audio files are retained.`))
      )
        app.playlists.delete(playlist.id);
      if (action === 'tracks') {
        const current = app.store.playlistTracks(playlist.id);
        const existing = new Set(current.map((track) => track.id));
        const ordered = [
          ...current,
          ...app.store.library().filter((track) => !existing.has(track.id)),
        ];
        const selectedIds = await broker.multiselect(
          'Choose playlist tracks (current order is preserved)',
          ordered.map((track) => ({ value: track.id, label: `${track.title} — ${track.artist}` })),
          current.map((track) => track.id),
        );
        app.store.setPlaylistTracks(playlist.id, selectedIds);
      }
      if (action === 'export') {
        await app.playlists.export(playlist.id, await broker.text('Output .m3u8 path'), true);
        setMessage('Exported playlist with relative paths.');
      }
    }
  };
  const libraryAction = async (track?: LibraryTrack): Promise<void> => {
    if (!track) {
      const result = await app.library.import(
        await broker.text('Directory or audio file to index'),
        { signal: app.operations.signal },
      );
      setMessage(
        `Indexed ${result.tracks.length} tracks · ${result.errors.length} skipped/errors.`,
      );
      return;
    }
    const info = await app.audio.probe(track.path, app.operations.signal);
    broker.note(
      `${track.path}\n${info.codec} · ${info.bitrate.toFixed(0)} kb/s · ${time(info.duration)} · artwork ${info.hasArtwork ? 'embedded' : 'absent'}`,
    );
    const action = await broker.select(`${track.title} — ${track.artist}`, [
      { value: 'done', label: 'Done' },
      { value: 'edit', label: 'Correct indexed metadata' },
      { value: 'playlist', label: 'Add to a playlist' },
    ]);
    if (action === 'edit') {
      const title = await broker.text('Title', track.title),
        artist = await broker.text('Artist', track.artist),
        album = await broker.text('Album', track.album);
      await app.library.correct(track.id, { title, artist, album });
      setMessage(
        'Updated library metadata. Use musicdl library edit --write-tags to also write the audio file.',
      );
    }
    if (action === 'playlist') {
      const id = await broker.select(
        'Choose playlist',
        app.store.playlists().map((p) => ({ value: p.id, label: p.name })),
      );
      app.playlists.add(id, [track.id]);
      setMessage('Added track to playlist.');
    }
  };
  useInput((keyInput, key) => {
    if (key.ctrl && keyInput === 'c') {
      quit();
      return;
    }
    if (modal) return;
    if (key.tab) {
      const index = tabs.indexOf(tab);
      setTab(tabs[(index + (key.shift ? tabs.length - 1 : 1)) % tabs.length]!);
      setCursor(0);
      setFiltering(false);
      return;
    }
    if (key.escape) {
      setTab('Home');
      setFiltering(false);
      return;
    }
    if (filtering) return;
    if (tab === 'Home') return;
    if (keyInput === 'q') {
      quit();
      return;
    }
    if (key.upArrow) setCursor(Math.max(0, selected - 1));
    if (key.downArrow) setCursor(Math.min(Math.max(0, list.length - 1), selected + 1));
    if (keyInput === '/' && tab === 'Library') {
      setFiltering(true);
      return;
    }
    if (busy) return;
    if ((tab === 'Active' || tab === 'Queue') && keyInput === 'c') {
      const job = (tab === 'Active' ? active : queued)[selected];
      if (job)
        work(async () => {
          await app.manager.cancel(job.id);
          setMessage(`Cancelled ${job.track.title}.`);
        });
    }
    if (tab === 'Queue' && keyInput === 'r') {
      const job = queued[selected];
      if (job) {
        try {
          app.manager.retry(job.id);
          setMessage('Queued for retry.');
        } catch (e) {
          setMessage(errorMessage(e));
        }
      }
    }
    if (tab === 'Library' && (key.return || keyInput === 'i'))
      work(() => libraryAction(keyInput === 'i' ? undefined : library[selected]));
    if (tab === 'Playlists' && (key.return || keyInput === 'n')) work(playlistAction);
    if (tab === 'Settings' && keyInput === 'd')
      work(async () => {
        const result = await doctor(app.runner, app.config);
        setMessage(result.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`).join('\n'));
      });
    if (tab === 'Settings' && key.return)
      work(async () => {
        const option = await broker.select('Settings', [
          { value: 'format', label: 'Output format' },
          { value: 'theme', label: 'Theme' },
          { value: 'concurrency', label: 'Concurrency' },
          { value: 'downloadsDir', label: 'Download directory' },
          { value: 'filenameTemplate', label: 'Filename template' },
        ]);
        if (option === 'format')
          await app.updateConfig({
            format: (await broker.select(
              'Format',
              ['mp3', 'm4a', 'opus', 'flac', 'original'].map((value) => ({
                value,
                label: value.toUpperCase(),
              })),
            )) as typeof app.config.format,
          });
        else if (option === 'theme')
          await app.updateConfig({
            theme: (await broker.select(
              'Theme',
              ['aurora', 'amber', 'mono'].map((value) => ({ value, label: value })),
            )) as typeof app.config.theme,
          });
        else if (option === 'concurrency')
          await app.updateConfig({
            concurrency: Number(
              await broker.text('Concurrent downloads (1–8)', String(app.config.concurrency)),
            ),
          });
        else if (option === 'downloadsDir')
          await app.updateConfig({
            downloadsDir: await broker.text('Download directory', app.config.downloadsDir),
          });
        else
          await app.updateConfig({
            filenameTemplate: await broker.text(
              'Template: {title}, {artist}, {album}, {track}, {id}',
              app.config.filenameTemplate,
            ),
          });
        setMessage('Settings saved. Tool and URL-policy changes take effect on restart.');
      });
  });
  usePaste(
    (text) => {
      if (tab === 'Home' && !modal && !busy)
        setInput((previous) => previous + text.replace(/[\r\n]+/g, ' '));
    },
    { isActive: tab === 'Home' && !modal && !busy },
  );
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text bold color={colors.accent}>
          ♫ MUSICDL
        </Text>
        <Text color={colors.muted}>
          {app.config.format.toUpperCase()} · {app.config.concurrency} workers · {library.length}{' '}
          tracks
        </Text>
      </Box>
      <Box marginTop={1} flexWrap="wrap" gap={2}>
        {tabs.map((name) => (
          <Text key={name} bold={tab === name} color={tab === name ? colors.accent : colors.muted}>
            {tab === name ? '● ' : ''}
            {name}
          </Text>
        ))}
      </Box>
      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="round"
        borderColor={colors.border}
        paddingX={1}
        width={width}
      >
        {modal ? (
          <PromptModal
            key={`${modal.kind}:${modal.message}`}
            request={modal}
            rows={rows}
            accent={colors.accent}
            onCancel={() => broker.cancel()}
          />
        ) : (
          <>
            {tab === 'Home' && (
              <>
                <Text color={colors.muted}>Paste a URL or search for music...</Text>
                <Box>
                  <Text color={colors.accent}>› </Text>
                  <TextInput
                    value={input}
                    onChange={setInput}
                    onSubmit={submit}
                    focus={!busy}
                    placeholder="YouTube · YouTube Music · Spotify · title + artist"
                  />
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text bold>
                    Active downloads <Text color={colors.accent}>{active.length}</Text>{' '}
                    <Text dimColor>
                      · queued{' '}
                      {jobs.filter((j) => ['queued', 'retrying'].includes(j.status)).length}
                    </Text>
                  </Text>
                  {active.length ? (
                    active.slice(0, Math.max(2, rows - 3)).map((job) => (
                      <Box key={job.id} flexDirection="column">
                        <Text wrap="truncate">{safe(job.track.title)}</Text>
                        <Text color={colors.muted} wrap="truncate">
                          {progress(job)}
                        </Text>
                      </Box>
                    ))
                  ) : (
                    <Text color={colors.muted}>Your queue is ready.</Text>
                  )}
                </Box>
              </>
            )}
            {tab === 'Settings' && (
              <Box flexDirection="column">
                <Text>Format {app.config.format}</Text>
                <Text>Quality MP3 LAME VBR q2 · source-aware conversion</Text>
                <Text>Downloads {safe(app.config.downloadsDir)}</Text>
                <Text>Library {app.config.libraryDirs.map(safe).join(', ')}</Text>
                <Text>Concurrency {app.config.concurrency}</Text>
                <Text>Theme {app.config.theme}</Text>
                <Text dimColor>Enter edits · d diagnoses dependencies</Text>
              </Box>
            )}
            {tab === 'Library' && (
              <Box>
                <Text color={colors.accent}>Filter: </Text>
                {filtering ? (
                  <TextInput
                    value={filter}
                    onChange={setFilter}
                    onSubmit={() => {
                      setFiltering(false);
                      setCursor(0);
                    }}
                  />
                ) : (
                  <Text>{safe(filter) || 'all music · / to search'}</Text>
                )}
              </Box>
            )}
            {tab !== 'Home' && tab !== 'Settings' && (
              <Box flexDirection="column">
                {!list.length && (
                  <Text color={colors.muted}>
                    {tab === 'Library'
                      ? 'No indexed tracks. Press i to import an audio file or directory.'
                      : tab === 'Playlists'
                        ? 'No playlists. Press n to create or import one.'
                        : 'Nothing here yet.'}
                  </Text>
                )}
                {list.slice(start, start + rows).map((item, i) => {
                  const focus = start + i === selected;
                  let label = '';
                  if (tab === 'Active' || tab === 'Queue') {
                    const job = item as Job;
                    label = `${job.status.padEnd(11)} ${job.track.title}${job.error ? ` · ${job.error}` : ''}`;
                  } else if (tab === 'Library') {
                    const track = item as LibraryTrack;
                    label = `${track.title} — ${track.artist} · ${track.codec} · ${time(track.duration)}`;
                  } else if (tab === 'Playlists') {
                    const playlist = item as { id: string; name: string };
                    label = `${playlist.name} · ${app.store.playlistTracks(playlist.id).length} tracks`;
                  } else {
                    const entry = item as { title: string; status: string };
                    label = `${entry.status.padEnd(11)} ${entry.title}`;
                  }
                  return (
                    <Text
                      key={String(item.id)}
                      {...(focus ? { color: colors.accent } : {})}
                      wrap="truncate"
                    >
                      {focus ? '› ' : '  '}
                      {safe(label)}
                    </Text>
                  );
                })}
                {list.length > rows && (
                  <Text dimColor>
                    {selected + 1}/{list.length} · ↑ ↓ to scroll
                  </Text>
                )}
              </Box>
            )}
          </>
        )}
      </Box>
      <Box marginTop={1} width={width} flexDirection="column">
        <Text color={busy ? colors.accent : colors.muted}>
          {busy ? '◌ ' : ''}
          {message.split('\n').slice(0, 6).map(safe).join('\n')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={colors.muted}>
          {tab === 'Home'
            ? 'Enter resolve/download'
            : tab === 'Library'
              ? 'Enter inspect · i import · / filter'
              : tab === 'Active'
                ? 'c cancel'
                : tab === 'Queue'
                  ? 'c cancel · r retry'
                  : tab === 'Playlists'
                    ? 'Enter manage · n new/import'
                    : '↑ ↓ browse'}{' '}
          · Tab navigate · Esc home · Ctrl+C quit
        </Text>
      </Box>
      <Text dimColor>
        Download only content you are authorized to save. Existing files are preserved.
      </Text>
    </Box>
  );
}
function PromptModal({
  request,
  rows,
  accent,
  onCancel,
}: {
  request: PromptRequest;
  rows: number;
  accent: string;
  onCancel: () => void;
}): React.JSX.Element {
  const [cursor, setCursor] = useState(
      Math.max(
        0,
        request.options.findIndex((option) => option.value === request.initial),
      ),
    ),
    [selected, setSelected] = useState(new Set(request.initialSelected)),
    [text, setText] = useState(request.initial);
  usePaste((value) => setText((previous) => previous + value.replace(/[\r\n]+/g, ' ')), {
    isActive: request.kind === 'text',
  });
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (request.kind === 'text') return;
    if (key.upArrow) setCursor((value) => Math.max(0, value - 1));
    if (key.downArrow) setCursor((value) => Math.min(request.options.length - 1, value + 1));
    if (request.kind === 'multiselect' && input === ' ')
      setSelected((previous) => {
        const next = new Set(previous),
          value = request.options[cursor]?.value;
        if (value) {
          if (next.has(value)) next.delete(value);
          else next.add(value);
        }
        return next;
      });
    if (request.kind === 'multiselect' && input === 'a')
      setSelected((previous) =>
        previous.size === request.options.length
          ? new Set()
          : new Set(request.options.map((o) => o.value)),
      );
    if (key.return) {
      if (request.kind === 'multiselect')
        request.resolve(request.options.filter((o) => selected.has(o.value)).map((o) => o.value));
      else
        request.resolve(
          request.kind === 'confirm'
            ? request.options[cursor]?.value === 'yes'
            : (request.options[cursor]?.value ?? ''),
        );
    }
  });
  const start = Math.max(0, cursor - rows + 1);
  return (
    <Box flexDirection="column">
      <Text bold>{safe(request.message)}</Text>
      {request.kind === 'text' ? (
        <TextInput value={text} onChange={setText} onSubmit={(value) => request.resolve(value)} />
      ) : (
        request.options.slice(start, start + rows).map((option, i) => (
          <Text
            key={option.value}
            wrap="truncate"
            {...(start + i === cursor ? { color: accent } : {})}
          >
            {start + i === cursor ? '› ' : '  '}
            {request.kind === 'multiselect' ? (selected.has(option.value) ? '◉ ' : '○ ') : ''}
            {safe(option.label)}
            {option.hint ? ` (${safe(option.hint)})` : ''}
          </Text>
        ))
      )}
      <Text dimColor>
        {request.kind === 'multiselect'
          ? `${selected.size} selected · Space toggle · a all · `
          : ''}
        ↑ ↓ choose · Enter confirm · Esc cancel
        {request.options.length > rows ? ` · ${cursor + 1}/${request.options.length}` : ''}
      </Text>
    </Box>
  );
}
export async function launchDashboard(app: MusicDL, initialTab: Tab = 'Home'): Promise<void> {
  const instance = render(<Dashboard app={app} initialTab={initialTab} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
