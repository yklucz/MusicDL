# MusicDL design

The supplied project specification authorizes a complete implementation in this directory. MusicDL uses Node 24.12 or newer, strict TypeScript, pnpm, Ink and Clack, the official downloader CLIs, FFmpeg/ffprobe and Node's built-in SQLite. It does not depend on a particular player.

## Architecture and approach

A UI-independent engine resolves provider metadata into typed tracks and collections. A video with playlist context retains both identities and requires a selection; only explicit individual track URLs enter the queue. Every yt-dlp download uses `--no-playlist`, an isolated output template and `--ignore-config`. Spotify is resolved with spotDL save, then each selected Spotify track is downloaded separately via spotDL. Spotify supplies metadata; its audio is generally matched from YouTube. No Spotify streams are decrypted.

Alternatives considered: a thin CLI wrapper cannot provide reliable persistent queue and library state; an always-running daemon adds deployment and cross-platform complexity. The selected approach is an in-process async engine with a durable SQLite queue, a single-worker process lock, and explicit restart recovery. Read-only commands can inspect state while the worker is running.

The processor probes the actual downloaded source, rejects lossy-to-FLAC requests, preserves matching codecs when practical, uses LAME `-q:a 2` for MP3 conversion and ID3v2.3, and embeds available artwork. Downloads remain in per-job staging until an exclusive publication succeeds; existing files are never replaced. Unicode-safe filename templates cannot introduce path traversal. Metadata edits update the library index and optionally write tags through the same staging/publication path.

SQLite stores queue items, history, indexed tracks, local playlists and ordered playlist membership. Downloads and library roots are separate defaults under ~/Music/MusicDL. Import indexes existing files without altering them. Organization and export first produce a reviewable plan; executing them requires explicit approval. Device adapters export copies and playlists; Canary3DS is an optional adapter and never edits an existing library implicitly.

The Ink dashboard keeps the universal input visible on Home and shows live queue progress, library search, playlists, history and settings. Shared selection prompts support Clack in direct CLI invocations and modal keyboard controls inside Ink. Noninteractive mixed links require --single or --playlist. Batch confirmation cannot be bypassed by absence of a terminal; --yes is explicit approval.

## Reliability and validation

Use argument-array subprocesses without a shell, bounded output, abort signals and process-tree cancellation. Validate public HTTP(S) URLs and strip provider tracking context from selected track URLs. Persist credentials only in protected user configuration and never show subprocess command lines or raw credential-bearing errors. Handle retries with persisted exponential delays, restart interrupted jobs, deduplicate by provider identity, ISRC and existing paths, and keep failed staging available only until retry/cancellation cleanup.

Tests cover mixed URL safety, malformed metadata, Unicode/traversal, atomic publication, SQLite recovery, concurrency, retries, cancellation, playlist order, imports and exports. Real local HTTP audio produced by FFmpeg is an authorized end-to-end source. Public provider network checks establish availability only; no copyrighted sample is downloaded. Windows and Linux receive CI coverage and portable setup instructions; this session can directly validate macOS only.
