import type { Runner } from './core/process.js';
import type {
  Tools,
  Track,
  ResolvedInput,
  Collection,
  Selection,
  SelectionFlags,
} from './core/types.js';
import type { PromptPort } from './prompts.js';
import { MusicDLError } from './core/errors.js';
import { validateUrl } from './core/safety.js';
import {
  object,
  parseJson,
  spotifyTrack,
  str,
  ytCollection,
  ytTrack,
} from './providers/metadata.js';
import { ytMetadataArgs, ytBaseArgs } from './providers/ytdlp.js';

export class Resolver {
  constructor(
    private readonly runner: Runner,
    private readonly tools: Tools,
    private readonly allowLocal = false,
  ) {}
  async resolve(input: string, signal?: AbortSignal): Promise<ResolvedInput> {
    const url = validateUrl(input.trim(), this.allowLocal);
    const host = url.hostname.toLowerCase();
    if (host === 'open.spotify.com') return this.spotify(url, signal);
    if (host === 'spotify.link' || host === 'spoti.fi')
      throw new MusicDLError(
        'Paste the full open.spotify.com track, album or playlist URL.',
        'UNSUPPORTED',
      );
    const youtube = /^(?:(?:www|music|m)\.)?youtube\.com$/.test(host) || host === 'youtu.be';
    const selectedVideo =
      youtube &&
      (url.searchParams.has('v') ||
        host === 'youtu.be' ||
        /^\/(shorts|embed|live)\//.test(url.pathname));
    const playlistId = youtube ? url.searchParams.get('list') : null;
    const explicitCollection = youtube && !selectedVideo && !!playlistId;
    const response = await this.runner.run(
      this.tools.ytdlp,
      ytMetadataArgs(url.toString(), explicitCollection),
      { signal },
    );
    const data = parseJson(response.stdout);
    if (Array.isArray(object(data).entries))
      return { kind: 'collection', collection: ytCollection(data, url.toString()) };
    const track = ytTrack(data, url.toString());
    // Provider metadata must identify the selected video; parameters preserve its separate collection context.
    if (selectedVideo && playlistId && track.provider === 'youtube')
      return {
        kind: 'context',
        track,
        collectionUrl: `https://${host === 'music.youtube.com' ? 'music.youtube.com' : 'www.youtube.com'}/playlist?list=${encodeURIComponent(playlistId)}`,
      };
    return { kind: 'track', track };
  }
  async collection(url: string, signal?: AbortSignal): Promise<Collection> {
    const validated = validateUrl(url, this.allowLocal);
    if (validated.hostname === 'open.spotify.com') {
      const result = await this.spotify(validated, signal);
      if (result.kind === 'collection') return result.collection;
      throw new MusicDLError('This Spotify URL is not a collection.', 'SELECTION');
    }
    const result = await this.runner.run(this.tools.ytdlp, ytMetadataArgs(url, true), { signal });
    return ytCollection(parseJson(result.stdout), url);
  }
  async search(query: string, signal?: AbortSignal): Promise<Track[]> {
    if (!query.trim() || query.length > 500 || /[\u0000-\u001f]/.test(query))
      throw new MusicDLError(
        'Enter a song title and artist (up to 500 characters).',
        'INVALID_QUERY',
      );
    const result = await this.runner.run(
      this.tools.ytdlp,
      [...ytBaseArgs, '--flat-playlist', '--dump-single-json', '--', `ytsearch10:${query.trim()}`],
      { signal },
    );
    const data = object(parseJson(result.stdout));
    if (!Array.isArray(data.entries))
      throw new MusicDLError('Search returned invalid metadata.', 'METADATA');
    return data.entries
      .map((entry) =>
        ytTrack({ ...object(entry), extractor_key: 'Youtube' }, 'https://www.youtube.com'),
      )
      .filter((t) => t.title);
  }
  private async spotify(url: URL, signal?: AbortSignal): Promise<ResolvedInput> {
    const match = url.pathname.match(
      /^\/(?:intl-[a-z]+\/)?(track|album|playlist)\/([a-zA-Z0-9]{22})\/?$/,
    );
    if (!match)
      throw new MusicDLError('Use a Spotify track, album or playlist URL.', 'UNSUPPORTED');
    const kind = match[1]!,
      id = match[2]!;
    const canonical = `https://open.spotify.com/${kind}/${id}`;
    const result = await this.runner.run(
      this.tools.spotdl,
      ['save', canonical, '--save-file', '-', '--log-level', 'ERROR'],
      { signal, timeoutMs: 240_000 },
    );
    const data = parseJson(result.stdout);
    if (!Array.isArray(data) || !data.length)
      throw new MusicDLError(
        'Spotify returned no accessible tracks. The item may be private or unavailable.',
        'UNAVAILABLE',
      );
    const tracks: Track[] = [];
    let unavailableCount = 0;
    for (const item of data) {
      try {
        tracks.push(spotifyTrack(item));
      } catch {
        unavailableCount++;
      }
    }
    if (kind === 'track') {
      if (!tracks[0]) throw new MusicDLError('Spotify track is unavailable.', 'UNAVAILABLE');
      return { kind: 'track', track: tracks[0] };
    }
    if (kind === 'album')
      tracks.sort(
        (a, b) =>
          (a.discNumber ?? 1) - (b.discNumber ?? 1) ||
          (a.trackNumber ?? a.collectionPosition ?? Number.MAX_SAFE_INTEGER) -
            (b.trackNumber ?? b.collectionPosition ?? Number.MAX_SAFE_INTEGER),
      );
    else if (tracks.every((track) => track.collectionPosition !== undefined))
      tracks.sort((a, b) => a.collectionPosition! - b.collectionPosition!);
    const first = object(data[0]);
    return {
      kind: 'collection',
      collection: {
        id,
        url: canonical,
        title: str(first.list_name) ?? str(first.album_name) ?? `Spotify ${kind}`,
        creator: kind === 'album' ? str(first.album_artist) : str(first.list_owner),
        kind: kind === 'album' ? 'album' : 'playlist',
        tracks,
        totalCount: data.length,
        unavailableCount,
      },
    };
  }
}
export async function selectTracks(
  resolver: Resolver,
  result: ResolvedInput,
  flags: SelectionFlags,
  prompts: PromptPort,
  signal?: AbortSignal,
): Promise<Selection> {
  signal?.throwIfAborted();
  if (flags.single && flags.playlist)
    throw new MusicDLError('--single and --playlist cannot be used together.', 'SELECTION');
  if (result.kind === 'track') return { tracks: [result.track] };
  if (result.kind === 'context') {
    let choice = flags.single ? 'single' : flags.playlist ? 'all' : '';
    if (!choice) {
      if (!prompts.interactive)
        throw new MusicDLError(
          'This video has playlist context. Use --single or --playlist explicitly.',
          'SELECTION',
        );
      choice = await prompts.select(
        `“${result.track.title}” belongs to a playlist. What would you like?`,
        [
          { value: 'single', label: 'Download this song only', hint: 'default' },
          { value: 'all', label: 'Download the entire playlist' },
          { value: 'select', label: 'Select specific songs from the playlist' },
          { value: 'cancel', label: 'Cancel' },
        ],
        'single',
      );
    }
    if (choice === 'cancel') return { tracks: [] };
    if (choice === 'single') return { tracks: [result.track] };
    const collection = await resolver.collection(result.collectionUrl, signal);
    return chooseCollection(collection, choice === 'select', prompts);
  }
  if (flags.single)
    throw new MusicDLError(
      'This URL is a collection. Paste a track URL to use --single.',
      'SELECTION',
    );
  const collection = result.collection;
  if (!flags.playlist && !flags.yes) {
    if (!prompts.interactive)
      throw new MusicDLError(
        'Collection preview requires a terminal. Use --playlist to select all tracks.',
        'SELECTION',
      );
    preview(collection, prompts);
    const choice = await prompts.select(
      `${collection.title} · ${collection.tracks.length} available tracks`,
      [
        { value: 'all', label: 'Download the entire collection' },
        { value: 'select', label: 'Select individual tracks' },
        { value: 'cancel', label: 'Cancel' },
      ],
    );
    if (choice === 'cancel') return { tracks: [] };
    return chooseCollection(collection, choice === 'select', prompts);
  }
  return chooseCollection(collection, false, prompts);
}
function preview(collection: Collection, prompts: PromptPort): void {
  prompts.note(
    `${collection.title}${collection.creator ? ` · ${collection.creator}` : ''} · ${collection.totalCount} tracks\n${collection.tracks
      .slice(0, 12)
      .map((t, i) => `${i + 1}. ${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
      .join(
        '\n',
      )}${collection.tracks.length > 12 ? '\n… select tracks to browse the full list' : ''}${collection.unavailableCount ? `\n${collection.unavailableCount} unavailable entries excluded.` : ''}`,
  );
}
async function chooseCollection(
  collection: Collection,
  select: boolean,
  prompts: PromptPort,
): Promise<Selection> {
  if (!collection.tracks.length)
    throw new MusicDLError('No accessible tracks in this collection.', 'UNAVAILABLE');
  if (!select) {
    preview(collection, prompts);
    return { tracks: collection.tracks, collection };
  }
  const keys = new Set(
    await prompts.multiselect(
      'Select tracks (Space toggles, Enter confirms)',
      collection.tracks.map((t, i) => ({
        value: t.key,
        label: `${i + 1}. ${t.title}${t.artist ? ` — ${t.artist}` : ''}`,
      })),
    ),
  );
  return { tracks: collection.tracks.filter((t) => keys.has(t.key)), collection };
}
