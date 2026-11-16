import type { Track, Provider, Collection } from '../core/types.js';
import { MusicDLError } from '../core/errors.js';
import { cleanText } from '../core/safety.js';
export type Data = Record<string, unknown>;
export function object(value: unknown): Data {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : {};
}
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? cleanText(value).trim() : undefined;
}
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MusicDLError(
      'Provider returned invalid metadata. Update the tool with musicdl doctor instructions.',
      'METADATA',
    );
  }
}
export function ytTrack(value: unknown, fallbackUrl: string): Track {
  const d = object(value);
  const id = str(d.id),
    title = str(d.track) ?? str(d.title);
  if (!id || !title || d.has_drm === true)
    throw new MusicDLError(
      'Track metadata is incomplete or the source is DRM protected.',
      'METADATA',
    );
  const isYoutube =
    /youtube|youtu\.be/i.test(str(d.extractor_key) ?? str(d.extractor) ?? str(d.ie_key) ?? '') ||
    (/^[\w-]{11}$/.test(id) && /youtu(?:be\.com|\.be)/.test(fallbackUrl));
  const provider: Provider = isYoutube ? 'youtube' : 'ytdlp';
  const url = isYoutube
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
    : (str(d.webpage_url) ??
      str(d.original_url) ??
      (str(d.url)?.startsWith('http') ? str(d.url)! : fallbackUrl));
  const thumbnails = Array.isArray(d.thumbnails) ? d.thumbnails.map(object) : [];
  const format = object(
    Array.isArray(d.requested_downloads) ? d.requested_downloads[0] : undefined,
  );
  const extension = str(format.ext) ?? str(d.ext),
    codec = str(format.acodec) ?? str(d.acodec);
  const date = str(d.release_date);
  return {
    key:
      provider === 'youtube'
        ? `youtube:${id}`
        : `ytdlp:${str(d.extractor_key) ?? new URL(url).hostname}:${id}`,
    id,
    provider,
    url,
    title,
    artist: str(d.artist) ?? str(d.creator) ?? str(d.uploader),
    album: str(d.album),
    albumArtist: str(d.album_artist),
    releaseDate: date?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    trackNumber: num(d.track_number),
    discNumber: num(d.disc_number),
    genre: str(d.genre),
    duration: num(d.duration),
    artworkUrl: str(d.thumbnail) ?? str(thumbnails.at(-1)?.url),
    source: {
      codec,
      extension,
      bitrate: num(format.abr) ?? num(d.abr),
      lossless: codec ? /^(flac|alac|wavpack|ape|pcm_)/i.test(codec) : undefined,
    },
    confidence: str(d.artist) || str(d.track) ? 'provider' : 'inferred',
  };
}
export function ytCollection(value: unknown, url: string): Collection {
  const d = object(value);
  if (!Array.isArray(d.entries))
    throw new MusicDLError('Provider did not return collection metadata.', 'METADATA');
  let unavailableCount = 0;
  const tracks: Track[] = [];
  for (const entry of d.entries) {
    const e = object(entry);
    if (
      !entry ||
      ['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(
        String(e.availability),
      ) ||
      /^\[(Private|Deleted|Unavailable) video\]$/i.test(String(e.title))
    ) {
      unavailableCount++;
      continue;
    }
    try {
      const track = ytTrack(e, url);
      if (!tracks.some((t) => t.url === track.url)) tracks.push(track);
    } catch {
      unavailableCount++;
    }
  }
  const location = new URL(url);
  const isAlbum =
    !!str(d.album) ||
    (location.hostname === 'music.youtube.com' &&
      (str(d.id) ?? location.searchParams.get('list') ?? '').startsWith('OLAK5uy'));
  const title = str(d.album) ?? str(d.title) ?? 'Untitled collection';
  if (isAlbum) for (const track of tracks) track.album ??= title;
  return {
    id: str(d.id) ?? url,
    url,
    title,
    creator: str(d.uploader) ?? str(d.channel),
    kind: isAlbum ? 'album' : 'playlist',
    tracks,
    totalCount: num(d.playlist_count) ?? num(d.n_entries) ?? d.entries.length,
    unavailableCount,
  };
}
export function spotifyTrack(value: unknown): Track {
  const d = object(value);
  const url = str(d.url),
    id = str(d.song_id) ?? url?.match(/\/track\/([\w]+)/)?.[1],
    title = str(d.name);
  if (
    !url ||
    !id ||
    !title ||
    !/^https:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+(?:\?|$)/.test(url)
  )
    throw new MusicDLError('Spotify returned incomplete track metadata.', 'METADATA');
  const artists = Array.isArray(d.artists)
    ? d.artists.map(str).filter(Boolean).join(', ')
    : str(d.artist);
  return {
    key: `spotify:${id}`,
    id,
    provider: 'spotify',
    url: `https://open.spotify.com/track/${id}`,
    title,
    artist: artists || undefined,
    album: str(d.album_name),
    albumArtist: str(d.album_artist),
    releaseDate: str(d.date) ?? str(d.year),
    trackNumber: num(d.track_number),
    discNumber: num(d.disc_number),
    genre: Array.isArray(d.genres) ? str(d.genres[0]) : str(d.genre),
    duration: num(d.duration),
    artworkUrl: str(d.cover_url),
    isrc: str(d.isrc),
    collectionPosition: num(d.list_position),
    confidence: 'provider',
  };
}
