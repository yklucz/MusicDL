# MusicDL

A keyboard-driven music downloader and independent music library manager for Node.js. Paste a URL or search for a song in one field. You do not choose “song” or “playlist” before pasting.

MusicDL uses official yt-dlp and spotDL subprocesses, FFmpeg/ffprobe, an async persistent queue, and SQLite. It downloads only accessible sources; it does not bypass DRM, paywalls, or authentication. Download only content you are authorized to save.

## Install

Requires **Node.js 24.12+**, **pnpm 12**, **FFmpeg/ffprobe**, **yt-dlp**, and **spotDL**. Python runs the official downloader tools and a small bridge to spotDL's installed playlist SDK. No Python application backend or native SQLite addon is required.

```sh
cd ~/Documents/MusicDL
pnpm install --frozen-lockfile
pnpm build
pnpm run setup
musicdl doctor
musicdl
```

`pnpm run setup` builds the project and installs a launcher in `~/.local/bin` on macOS/Linux. If necessary, add that directory to PATH. On this machine it is already on PATH. The launcher uses the installed project directory; keep that directory in place. `MUSICDL_BIN_DIR` can choose another launcher directory. Existing unrelated launchers are retained. Use the explicit `run`: pnpm also has an unrelated built-in `setup` command.

macOS with Homebrew:

```sh
brew install node pnpm ffmpeg yt-dlp uv
pnpm setup:tools
```

`setup:tools` installs pinned official spotDL and yt-dlp in `.tools/spotdl` using uv and Python 3.13, without modifying system Python. Both project-local tools are discovered automatically when installed. To explicitly choose an executable:

```sh
musicdl config set tools.ytdlp "$PWD/.tools/spotdl/bin/yt-dlp"
```

On Linux, install Node/pnpm, FFmpeg and uv using their official instructions or your distribution's package manager, then use the same project commands. On Windows, install Node 24.12+, pnpm, FFmpeg and uv; run the commands in PowerShell. The launcher goes in `%LOCALAPPDATA%\MusicDL\bin`; add it to PATH. The isolated tool executables are in `.tools\spotdl\Scripts`. `musicdl doctor` verifies tool versions, required CLI options and audio encoders. Provider changes may require updating the official tools and configuring their executable paths.

## One input, safe selection

| Input                                    | Behavior                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| YouTube video                            | Resolve provider metadata and download one track.                                  |
| YouTube playlist                         | Preview title, creator, count and contents; choose all, checked tracks, or cancel. |
| Video with `v` and `list` context        | Ask **this song only** (default), entire playlist, checked songs, or cancel.       |
| YouTube Music song with playlist context | Same explicit choice.                                                              |
| YouTube Music album/playlist             | Preview the resolved collection and choose tracks.                                 |
| Spotify track                            | Fetch metadata through spotDL, then download one matched track.                    |
| Spotify album/playlist                   | Preview and select tracks before enqueueing individual Spotify track URLs.         |
| Other HTTP(S) URL                        | Let yt-dlp metadata determine whether it is a track or collection.                 |
| Song title and artist                    | Search YouTube; select the results to download.                                    |

**spotDL generally reads Spotify metadata and matches audio from YouTube or YouTube Music. It does not download Spotify's original streams.** Matches can differ from the exact release. Use `--edit-metadata` before downloading or `library edit` afterward when corrections are needed. Official Spotify cover artwork is preferred when supplied by spotDL; other providers use their available artwork without inventing release art.

Paste several URLs separated by spaces or newlines. Mixed pasted prose and URLs is rejected. Queued items are always individual tracks, and every yt-dlp download explicitly uses `--no-playlist` with isolated configuration. Unavailable entries are excluded and counted. Collections too large for the bounded metadata output produce a clear error rather than silently selecting a partial set.

Spotify metadata loading shows elapsed time and an animated activity indicator even while the provider is silent. Playlist page counts appear as pages arrive; Tab navigation remains available and **Esc cancels metadata retrieval**. The metadata operation times out after four minutes and reports sanitized recent provider activity. No audio is queued until collection selection and any batch confirmation finish.

With the pinned **spotDL 4.6.0** environment installed by `pnpm setup:tools`, playlist metadata comes from the same public SDK used by spotDL, in pages of up to 343 entries. This avoids the save command's per-track enrichment, lyric searches and unrelated YouTube Music probe. MusicDL checks page offsets, totals, revisions when provided, and every available track before showing the selection. Original positions and release artwork are retained; explicitly unavailable entries are counted. Truncated or malformed metadata fails instead of being presented as a complete collection. A standalone spotDL installation without its companion Python environment produces setup instructions for playlists, because `save` alone cannot prove pagination completed. Tracks and albums continue to use `spotdl save`, with lyric searches and the unrelated connectivity probe disabled. Missing optional metadata is left unset, and corrections remain available through `--edit-metadata`.

Direct CLI examples (quote URLs containing `&`):

```sh
musicdl 'https://www.youtube.com/watch?v=VIDEO_ID'
musicdl download 'https://music.youtube.com/watch?v=VIDEO_ID&list=PLAYLIST_ID'
musicdl download 'https://www.youtube.com/watch?v=VIDEO_ID&list=PLAYLIST_ID' --single
musicdl download 'https://www.youtube.com/playlist?list=PLAYLIST_ID' --playlist --yes
musicdl download 'PLAYLIST_URL' --playlist --local-playlist 'Road trip'
musicdl download 'URL_1' 'URL_2' --queue-only
musicdl resolve 'URL'       # Metadata only
musicdl search 'artist song title'
musicdl search 'artist song title' --download
```

`--single` and `--playlist` are mutually exclusive explicit overrides. A mixed video-plus-playlist link in a noninteractive shell **always requires one of them**; `--yes` alone does not decide its scope. `--single` rejects collection-only URLs. Noninteractive collections require `--playlist` or `--yes`. Batches of **20 or more** selected tracks require confirmation; `--yes` explicitly approves that count. Existing indexed/queued tracks in the requested format are skipped. Existing filenames cause a visible failure and are never replaced.

## Terminal controls

| View              | Keys                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| Home              | Paste/type, Enter to resolve or search                                                  |
| All views         | Tab / Shift+Tab to navigate; Esc for Home (cancel while metadata loads); Ctrl+C to quit |
| Active / Queue    | Up/Down to select; `c` cancel; Queue `r` retries failed/cancelled jobs                  |
| Library           | `/` filter, Enter inspect/correct/add to playlist, `i` import                           |
| Playlists         | `n` create/import, Enter manage selected playlist                                       |
| Settings          | Enter edit, `d` run doctor                                                              |
| Selection prompts | Up/Down, Space toggles checkboxes, `a` toggles all, Enter confirms, Esc cancels         |

Downloads remain asynchronous while navigating. yt-dlp progress includes percentage, speed and ETA when the provider supplies them. spotDL exposes less stable progress through its CLI: matching/downloading status is always displayed, percentages when present; unavailable speed/ETA are not estimated. Exiting stops child processes and leaves unfinished jobs recoverable. Relaunching `musicdl` resumes them. The application must remain open to run downloads; `queue-only` does not start a background daemon.

```sh
musicdl queue
musicdl queue run
musicdl queue cancel JOB_ID
musicdl queue retry JOB_ID
musicdl history
```

One queue worker owns a state directory at a time. Other CLI invocations can inspect or add to its queue and request cancellation. SQLite persists attempts and exponential retry delays. Original source files and intermediate output live in private per-job staging directories; successful jobs remove them. A content hash plus codec/duration journal recovers the interval between exclusive file publication and database completion. Completed audio is never removed by queue cancellation or cleanup.

## Audio and metadata

- **MP3** defaults to FFmpeg **LAME VBR `-q:a 2`**, ID3v2.3, Unicode tags and embedded cover art. Existing MP3 streams can be copied to avoid another lossy encode.
- **M4A** copies AAC/ALAC when possible; other codecs use AAC at 256 kb/s.
- **Opus** copies Opus when possible; other codecs use Opus VBR at 160 kb/s. Cover art uses the standard picture metadata block.
- **FLAC** prefers lossless formats and probes the downloaded audio. Lossy sources are rejected. Converting lossy audio to FLAC does not restore quality; Spotify/YouTube matching is not offered as lossless.
- **Original** preserves the audio codec, remuxing AAC/Opus/Vorbis to compatible audio containers. A container that FFmpeg cannot safely remux/tag fails visibly.

The highest available audio source is requested. No source bitrate guarantee is made: free provider availability governs what the tools can obtain. Source codec and bitrate appear when metadata supplies them; `library inspect` probes the actual file. Title, artist, album, album artist, release date, track/disc number, genre and ISRC are applied when reliable provider values exist. Artwork retrieval failure does not discard otherwise valid audio; the queue displays the warning. Artwork is normalized to a bounded JPEG for compatibility. Metadata is not inferred from unreliable genre guesses.

Default filename: **`Song Title - Artist.mp3`**. Allowed template fields: `{title}`, `{artist}`, `{album}`, `{track}`, `{id}`. Directory separators and traversal are rejected; field values preserve Unicode while removing unsafe filename and terminal characters.

## Library

Default directories are independent of every player:

- Downloads: `~/Music/MusicDL/Downloads`
- Library: `~/Music/MusicDL/Library`

Downloaded files are indexed where they were saved. Import indexes existing files **without editing or moving them**. Add as many library roots as desired. Scans are explicit, symlinks are skipped, and content hashes identify identical files. No duplicate is deleted automatically.

```sh
musicdl config set libraryDirs '["~/Music/MusicDL/Library", "~/Music/Other"]'
musicdl library import ~/Music/Existing
musicdl library import ./album --copy
musicdl library scan
musicdl library 'artist name'
musicdl library inspect TRACK_ID
musicdl library convert TRACK_ID --format mp3 --output ~/Music/MP3-Copies
musicdl library duplicates
musicdl library missing
musicdl library edit TRACK_ID --title 'Correct title' --artist 'Correct artist'
musicdl library edit TRACK_ID --album 'Correct album' --write-tags
musicdl library organize ~/Music/Organized --structure artist-album
musicdl library organize ~/Music/Organized --structure artist-album --apply
musicdl library export ./library-index.json
musicdl export ./music-copy --yes
```

Index edits affect the index. `--write-tags` displays the concrete file update and requires confirmation (or `--yes`), preserving an original `.musicdl-backup-*` file. Organization displays the source/destination move plan; execution needs interactive approval or `--apply`. Folder exports copy files and retain embedded art. Export plans reject existing destination files and conflicting names. If a device disconnects during an export, successfully copied files remain; inspect the destination before retrying. JSON exports are index manifests; audio import operates on files/directories, not manifest restoration.

## Playlists

Playlists reference indexed audio rather than duplicating it. Entry order is persistent; duplicate memberships are ignored. M3U and UTF-8 M3U8 imports support local relative/absolute paths and report missing or rejected remote entries. Exports default to relative paths and never replace an existing playlist file.

```sh
musicdl playlists create Favorites
musicdl playlists add Favorites TRACK_ID_1 TRACK_ID_2
musicdl playlists show Favorites
musicdl playlists remove Favorites TRACK_ID_1
musicdl playlists reorder Favorites TRACK_ID_2 TRACK_ID_3
musicdl playlists rename Favorites 'Night music'
musicdl playlists import ./old.m3u8 --name Imported
musicdl playlists export Imported ./imported.m3u8
musicdl playlists export Imported ./absolute.m3u8 --absolute
musicdl playlists delete Imported --yes
```

An online collection can create a local ordered M3U8 with `--local-playlist [name]`. This request survives restarts, and the local playlist references completed tracks and already-indexed duplicates. Failed/unavailable tracks are omitted and reported. No second audio copy is created.

## Optional Canary3DS export

Canary3DS is an adapter, not a dependency of the library or downloader. To use an existing library such as `~/Documents/Canary-MP3-Test`, explicitly import it first. Nothing in that directory is edited automatically.

```sh
musicdl library import ~/Documents/Canary-MP3-Test
musicdl export /Volumes/SDCARD --device canary3ds --playlist Favorites
# Review the copy plan, then confirm interactively or use --yes.
```

Supply the **mounted SD card root**, not a literal `sdmc:` host path. MP3 copies go to `Music/MusicDL/`; playlists go to `3ds/Canary/Playlists/`, using `sdmc:/Music/MusicDL/...` references. Existing embedded artwork is preserved. Non-MP3 tracks are rejected; request MP3 downloads or convert copies first. Physical Canary playback and device-specific artwork limits still need validation on the device. No firmware, device files or existing library are modified by setup.

## Settings, storage and development

```sh
musicdl config
musicdl config path
musicdl config set format opus
musicdl config set theme amber       # aurora | amber | mono
musicdl config set concurrency 3
musicdl config set structure artist-album
musicdl config set filenameTemplate '{track} - {title} - {artist}'
```

Settings are validated and written atomically. macOS uses `~/Library/Application Support/MusicDL`, Linux follows XDG config/state directories, and Windows uses `%APPDATA%\MusicDL`. These contain `config.json`, the SQLite index/history/queue, staging and the worker ownership database. `MUSICDL_HOME` isolates configuration/state for tests or another profile; it does not redirect audio directories. See [config.example.json](config.example.json). Tool/URL-policy changes take effect after restarting. Local/private network URLs are disabled unless `allowLocalUrls` is explicitly enabled for trusted sources.

Commands are executed as argument arrays without a shell. Downloaders' implicit configuration and external exec hooks are disabled for yt-dlp. Subprocess output and artwork are bounded; credentials/cookies and unrecognized URL query parameters are redacted from errors/JSON logging. No cookies, passwords or tokens are requested by MusicDL. Database and configuration files use private permissions where the platform supports them.

```sh
pnpm check             # strict typechecks, all tests, production build
pnpm test:integration  # real yt-dlp/FFmpeg against locally generated audio
pnpm format:check
pnpm dev
```

The integration test needs yt-dlp, FFmpeg and ffprobe plus permission to bind localhost. It skips when media tools are absent; it never substitutes mock audio for an end-to-end pass. Unit/CLI/UI tests run without provider access; paging tests exercise the Python bridge with deterministic page fixtures. [Validation notes](docs/validation.md) distinguish actual results, public metadata probes, and unverified platform/device behavior. CI uses native `macos-latest` with Homebrew FFmpeg, plus Ubuntu and Windows. Every runner verifies both `ffmpeg` and `ffprobe`. Git attributes enforce LF source checkouts so formatting checks agree across platforms.

The engine lives in `src/resolver.ts`, `src/providers`, `src/downloads`, `src/audio` and `src/storage`; library, playlists, settings and device adapters are separate modules. `src/cli.ts` and `src/ui` consume the same engine. There is no player-specific logic in the download queue.

Provider APIs, YouTube JavaScript challenges, availability, and rate limits change independently of MusicDL. Update official tools when needed; `doctor` does not promise that a particular remote item is accessible. No live Spotify-matched audio was downloaded during development. Windows/Linux behavior and physical Canary playback have not been directly tested in this macOS session.

Official tool references: [yt-dlp options](https://github.com/yt-dlp/yt-dlp#usage-and-options) and [spotDL usage and audio matching](https://spotdl.readthedocs.io/en/latest/usage/).
