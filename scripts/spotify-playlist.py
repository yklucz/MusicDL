"""Read public playlist pages through the SDK already shipped with spotDL 4.6.

No login, cookies, audio lookup, lyric search, or per-track enrichment is performed.
All interpretation of song metadata stays in TypeScript.
"""

import argparse
import json
import re
import sys


class PlaylistMetadataError(Exception):
    """A safe diagnostic authored by MusicDL, without provider response bodies."""


def collect_playlist(pager, progress):
    entries = []
    total = None
    revision = None
    name = None
    creator = None
    while total is None or len(entries) < total:
        offset = len(entries)
        response = pager.get_playlist_info(limit=343, offset=offset)
        playlist = response.get("data", {}).get("playlistV2", {})
        content = playlist.get("content")
        if not isinstance(content, dict):
            raise PlaylistMetadataError("Playlist unavailable or not publicly accessible")
        page_total = content.get("totalCount")
        page = content.get("items")
        if not isinstance(page_total, int) or page_total < 0 or not isinstance(page, list):
            raise PlaylistMetadataError("Incomplete metadata: missing page count or entries")
        if total is None:
            total = page_total
            revision = playlist.get("revisionId")
            name = playlist.get("name")
            creator = playlist.get("ownerV2", {}).get("data", {}).get("name")
        if page_total != total or playlist.get("revisionId") != revision:
            raise PlaylistMetadataError("Incomplete metadata: playlist changed during pagination; retry")
        if content.get("pagingInfo", {}).get("offset", offset) != offset:
            raise PlaylistMetadataError("Incomplete metadata: provider returned the wrong page")
        if len(entries) + len(page) > total or (not page and len(entries) < total):
            raise PlaylistMetadataError("Incomplete metadata: truncated or inconsistent playlist page")
        entries.extend(page)
        progress(len(entries), total)
    return {"schema": "musicdl-spotify-playlist-v1", "complete": True,
            "total": total, "name": name, "creator": creator, "entries": entries}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"https://open\.spotify\.com/playlist/[a-zA-Z0-9]{22}", args.url):
        raise PlaylistMetadataError("Use a canonical public Spotify playlist URL")
    from importlib.metadata import version
    if version("spotdl") != "4.6.0":
        raise PlaylistMetadataError("The batch adapter requires spotDL 4.6.0; run pnpm setup:tools")
    # PublicPlaylist is the exact public metadata client used by spotDL's default
    # SpotipyFree backend. Its normal authentication and access checks remain intact.
    from spotapi import PublicPlaylist
    print("MUSICDL_META INFO Requesting public Spotify pages", flush=True)
    result = collect_playlist(
        PublicPlaylist(args.url.rsplit("/", 1)[-1]),
        lambda received, total: print(f"MUSICDL_META PAGE {received}/{total}", flush=True),
    )
    with open(args.output, "x", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SDK exceptions can contain raw HTTP headers or response bodies. Keep
        # their class and page progress, but never print those sensitive bodies.
        detail = str(error) if isinstance(error, PlaylistMetadataError) else "Provider request failed; retry or run musicdl doctor"
        print(f"MUSICDL_META ERROR {type(error).__name__}: {detail}", file=sys.stderr, flush=True)
        sys.exit(1)
