import path from 'node:path';
import { ProcessRunner } from './core/process.js';
import type { Runner } from './core/process.js';
import type { AudioFormat, SelectionFlags, Track } from './core/types.js';
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
    if (flags.single && flags.playlist)
      throw new MusicDLError('--single and --playlist cannot be used together.', 'SELECTION');
    const parsed = splitInput(input),
      tracks: Track[] = [];
    let collectionName: string | undefined;
    if (parsed.urls) {
      for (const url of parsed.urls) {
        prompts.note('Reading provider metadata…');
        const resolved = await this.resolver.resolve(url, this.operations.signal);
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
        const selected = await selectTracks(
          this.resolver,
          resolved,
          flags,
          prompts,
          this.operations.signal,
        );
        tracks.push(...selected.tracks);
        collectionName ??= selected.collection?.title;
      }
    } else {
      if (!prompts.interactive)
        throw new MusicDLError(
          'Search selection requires a terminal. Use musicdl search to list results.',
          'INTERACTIVE_REQUIRED',
        );
      const results = await this.resolver.search(parsed.query, this.operations.signal);
      const keys = new Set(
        await prompts.multiselect(
          'Search results · select tracks to download',
          results.map((t) => ({
            value: t.key,
            label: `${t.title}${t.artist ? ` — ${t.artist}` : ''}${t.duration ? ` (${Math.round(t.duration)}s)` : ''}`,
          })),
        ),
      );
      tracks.push(...results.filter((t) => keys.has(t.key)));
    }
    const unique = [...new Map(tracks.map((track) => [track.key, track])).values()];
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
    const result = await this.manager.enqueue(unique, flags.format ?? this.config.format);
    if (playlist) {
      const name =
        typeof playlist === 'string' ? playlist : (collectionName ?? 'MusicDL Downloads');
      this.store.createDownloadPlaylist(
        name,
        unique,
        path.join(this.config.downloadsDir, 'Playlists', `${safeSegment(name)}.m3u8`),
        flags.format ?? this.config.format,
      );
    }
    await this.manager.syncPlaylists();
    prompts.note(
      `Queued ${result.added.length} track${result.added.length === 1 ? '' : 's'}${result.skipped.length ? ` · ${result.skipped.length} duplicates skipped` : ''}.`,
    );
    return { added: result.added.length, skipped: result.skipped.length };
  }
}
