import path from 'node:path';
import { ProcessRunner } from './core/process.js';
import type { Runner } from './core/process.js';
import type { AudioFormat, SelectionFlags, Selection } from './core/types.js';
import { MusicDLError } from './core/errors.js';
import { safeSegment } from './core/safety.js';
import type { PromptPort } from './prompts.js';
import { appPaths, loadSettings, saveSettings } from './settings.js';
import type { Settings, AppPaths } from './settings.js';
import { Store } from './storage/store.js';
import { Resolver, selectTracks } from './resolver.js';
import { AudioProcessor } from './audio/processor.js';
import { createPipeline } from './downloads/source.js';
import { DownloadManager } from './downloads/manager.js';
import { collectionKey } from './downloads/collections.js';
import { Library } from './library.js';
import { PlaylistManager } from './playlists.js';

export interface DownloadFlags extends SelectionFlags {
  format?: AudioFormat | undefined;
  localPlaylist?: string | boolean | undefined;
  editMetadata?: boolean | undefined;
}
export function splitInput(
  input: string,
): { urls: string[]; query?: never } | { query: string; urls?: never } {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 65_536)
    throw new MusicDLError('Enter URLs or a song title and artist.', 'INVALID_INPUT');
  const parts = trimmed.split(/\s+/);
  if (parts.some((part) => /^https?:\/\//i.test(part))) {
    if (!parts.every((part) => /^https?:\/\//i.test(part)))
      throw new MusicDLError(
        'Paste only URLs together, or enter one search query.',
        'INVALID_INPUT',
      );
    if (parts.length > 100)
      throw new MusicDLError('Paste up to 100 URLs at a time.', 'INPUT_LIMIT');
    return { urls: [...new Set(parts)] };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed))
    throw new MusicDLError('Only HTTP(S) URLs are supported.', 'INVALID_URL');
  return { query: trimmed };
}
export async function confirmBatch(
  count: number,
  threshold: number,
  yes: boolean,
  prompt: PromptPort,
): Promise<boolean> {
  if (count < threshold || yes) return true;
  if (!prompt.interactive)
    throw new MusicDLError(
      `${count} tracks selected. Large batches require --yes or interactive confirmation.`,
      'CONFIRMATION',
    );
  return prompt.confirm(`Download ${count} selected tracks?`, false);
}
export class MusicDL {
  readonly operations = new AbortController();
  private inputOperation: AbortController | undefined;
  private closed = false;
  readonly resolver: Resolver;
  readonly audio: AudioProcessor;
  readonly manager: DownloadManager;
  readonly library: Library;
  readonly playlists: PlaylistManager;
  constructor(
    readonly config: Settings,
    readonly paths: AppPaths,
    readonly store: Store,
    readonly runner: Runner = new ProcessRunner(),
  ) {
    this.resolver = new Resolver(runner, config.tools, config.allowLocalUrls);
    this.audio = new AudioProcessor(runner, config.tools, config.allowLocalUrls);
    this.manager = new DownloadManager(
      store,
      config,
      createPipeline(runner, config, this.audio),
      paths.state,
    );
    this.library = new Library(store, this.audio);
    this.playlists = new PlaylistManager(store);
  }
  static async open(): Promise<MusicDL> {
    const paths = appPaths(),
      config = await loadSettings(paths);
    return new MusicDL(config, paths, new Store(paths.database));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.operations.abort();
    await this.manager.stop();
    this.store.close();
  }
  async updateConfig(patch: Partial<Settings>): Promise<void> {
    const saved = await saveSettings({ ...this.config, ...patch }, this.paths);
    Object.assign(this.config, saved);
  }
  async downloadInput(
    input: string,
    flags: DownloadFlags,
    prompts: PromptPort,
  ): Promise<{ added: number; skipped: number }> {
    if (this.inputOperation)
      throw new MusicDLError('Another input is still being resolved.', 'BUSY');
    const operation = new AbortController();
    this.inputOperation = operation;
    try {
      return await this.resolveSelection(
        input,
        flags,
        prompts,
        AbortSignal.any([this.operations.signal, operation.signal]),
      );
    } finally {
      this.inputOperation = undefined;
      prompts.progress?.(undefined);
    }
  }
  cancelInput(): void {
    this.inputOperation?.abort();
  }
  private async resolveSelection(
    input: string,
    flags: DownloadFlags,
    prompts: PromptPort,
    signal: AbortSignal,
  ): Promise<{ added: number; skipped: number }> {
    if (flags.single && flags.playlist)
      throw new MusicDLError('--single and --playlist cannot be used together.', 'SELECTION');
    const parsed = splitInput(input),
      selections: Selection[] = [];
    if (parsed.urls) {
      for (const url of parsed.urls) {
        prompts.note('Reading provider metadata…');
        const resolved = await this.resolver.resolve(url, signal, (value) =>
          prompts.progress?.(value),
        );
        if (resolved.kind !== 'collection') {
          const track = resolved.track;
          prompts.note(
            `${track.title}${track.artist ? ` — ${track.artist}` : ''}${track.album ? `\nAlbum: ${track.album}` : ''}${track.source?.codec ? `\nSource: ${track.source.codec}${track.source.bitrate ? ` · ${track.source.bitrate} kb/s` : ''}` : ''}`,
          );
        }
        if (url.includes('open.spotify.com'))
          prompts.note(
            'spotDL reads Spotify metadata and usually matches audio from YouTube; it does not download Spotify’s original streams. Matches may differ from the release.',
          );
        const selected = await selectTracks(this.resolver, resolved, flags, prompts, signal);
        selections.push(selected);
      }
    } else {
      if (!prompts.interactive)
        throw new MusicDLError(
          'Search selection requires a terminal. Use musicdl search to list results.',
          'INTERACTIVE_REQUIRED',
        );
      const results = await this.resolver.search(parsed.query, signal);
      const keys = new Set(
        await prompts.multiselect(
          'Search results · select tracks to download',
          results.map((t) => ({
            value: t.key,
            label: `${t.title}${t.artist ? ` — ${t.artist}` : ''}${t.duration ? ` (${Math.round(t.duration)}s)` : ''}`,
          })),
        ),
      );
      selections.push({ tracks: results.filter((t) => keys.has(t.key)) });
    }
    const groups = new Map<string, Selection>();
    for (const selection of selections) {
      const key =
        this.config.playlistFolders && selection.collection
          ? collectionKey(selection.collection)
          : 'standalone';
      const group = groups.get(key) ?? { tracks: [], collection: selection.collection };
      group.collection ??= selection.collection;
      group.tracks = [
        ...new Map(
          [...group.tracks, ...selection.tracks].map((track) => [track.key, track]),
        ).values(),
      ];
      groups.set(key, group);
    }
    const unique = [...groups.values()].flatMap((group) => group.tracks);
    const collectionName = selections.find((selection) => selection.collection)?.collection?.title;
    if (!unique.length) {
      prompts.note('No tracks selected.');
      return { added: 0, skipped: 0 };
    }
    prompts.note(
      `${unique.length} track${unique.length === 1 ? '' : 's'} selected · ${(flags.format ?? this.config.format).toUpperCase()}`,
    );
    if (
      !(await confirmBatch(
        unique.length,
        this.config.largeBatchThreshold,
        flags.yes ?? false,
        prompts,
      ))
    )
      return { added: 0, skipped: 0 };
    if (flags.editMetadata)
      for (const track of unique) {
        track.title = await prompts.text('Song title', track.title);
        track.artist = await prompts.text('Artist', track.artist ?? '');
        track.album = await prompts.text('Album', track.album ?? '');
        track.confidence = 'manual';
        if (!track.title.trim()) throw new MusicDLError('Song title cannot be empty.', 'METADATA');
      }
    let playlist =
      flags.localPlaylist ?? (this.config.createPlaylist && !!collectionName ? true : undefined);
    if (playlist === undefined && collectionName && prompts.interactive)
      playlist = await prompts.confirm('Create a local M3U8 playlist after downloading?', false);
    signal.throwIfAborted();
    let added = 0,
      skipped = 0;
    const folders: string[] = [];
    for (const group of groups.values()) {
      signal.throwIfAborted();
      if (!group.tracks.length) continue;
      const result = await this.manager.enqueue(
        group.tracks,
        flags.format ?? this.config.format,
        undefined,
        group.collection,
      );
      added += result.added.length;
      skipped += result.skipped.length;
      if (result.destination) folders.push(path.basename(result.destination.directory));
      if (playlist) {
        const name =
          typeof playlist === 'string'
            ? playlist
            : (group.collection?.title ?? 'MusicDL Downloads');
        this.store.createDownloadPlaylist(
          name,
          group.tracks,
          path.join(
            result.destination?.directory ?? path.join(this.config.downloadsDir, 'Playlists'),
            `${safeSegment(name)}.m3u8`,
          ),
          flags.format ?? this.config.format,
          result.destination,
        );
      }
    }
    await this.manager.syncPlaylists();
    prompts.note(
      `Queued ${added} track${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} duplicates skipped` : ''}.${folders.length ? `\nCollection folders: ${[...new Set(folders)].join(', ')}` : ''}`,
    );
    return { added, skipped };
  }
}
