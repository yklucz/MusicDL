import { describe, expect, it } from 'vitest';
import { spotifyPlaylistBatch } from '../src/providers/metadata.js';
const url = 'https://open.spotify.com/playlist/abcdefghijklmnopqrstuv';
const entry = (id: string) => ({
  itemV2: {
    data: {
      __typename: 'Track',
      uri: `spotify:track:${id}`,
      name: 'Bài hát',
      artists: { items: [{ profile: { name: 'Artist' } }] },
      albumOfTrack: {
        name: 'Official Album',
        coverArt: {
          sources: [{ url: 'https://i.scdn.co/image/official', width: 640, height: 640 }],
        },
        date: { isoString: '2026-01-01T00:00:00Z' },
      },
      trackDuration: { totalMilliseconds: 123000 },
      trackNumber: 3,
      discNumber: 1,
    },
  },
});
describe('paged metadata from the installed spotDL public SDK', () => {
  it('preserves playlist order, release details and artwork without per-track requests', () => {
    const result = spotifyPlaylistBatch(
      {
        schema: 'musicdl-spotify-playlist-v1',
        complete: true,
        total: 2,
        name: 'Playlist',
        creator: 'Creator',
        entries: [entry('abcdefghijklmnopqrstuv'), entry('1234567890123456789012')],
      },
      url,
    );
    expect(result.tracks.map((track) => track.id)).toEqual([
      'abcdefghijklmnopqrstuv',
      '1234567890123456789012',
    ]);
    expect(result.totalCount).toBe(2);
    expect(result.creator).toBe('Creator');
    expect(result.tracks[0]).toMatchObject({
      title: 'Bài hát',
      artist: 'Artist',
      album: 'Official Album',
      artworkUrl: 'https://i.scdn.co/image/official',
      releaseDate: '2026-01-01',
      duration: 123,
      trackNumber: 3,
    });
  });
  it('counts explicitly unavailable items without silently omitting them', () => {
    const result = spotifyPlaylistBatch(
      {
        schema: 'musicdl-spotify-playlist-v1',
        complete: true,
        total: 3,
        entries: [
          entry('abcdefghijklmnopqrstuv'),
          { itemV2: { data: { __typename: 'NotFound' } } },
          entry('1234567890123456789012'),
        ],
      },
      url,
    );
    expect(result.totalCount).toBe(3);
    expect(result.unavailableCount).toBe(1);
    expect(result.tracks).toHaveLength(2);
    expect(result.tracks.map((track) => track.collectionPosition)).toEqual([1, 3]);
  });
  it.each([
    { complete: false, total: 1, entries: [entry('abcdefghijklmnopqrstuv')] },
    { complete: true, total: 2, entries: [entry('abcdefghijklmnopqrstuv')] },
    {
      complete: true,
      total: 1,
      entries: [
        { itemV2: { data: { __typename: 'Track', uri: 'spotify:track:abcdefghijklmnopqrstuv' } } },
      ],
    },
  ])('rejects incomplete pages and malformed available tracks', (input) => {
    expect(() =>
      spotifyPlaylistBatch({ schema: 'musicdl-spotify-playlist-v1', ...input }, url),
    ).toThrow(/incomplete/i);
  });
});
