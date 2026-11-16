# Validation record

## Environment inspected

macOS Apple Silicon; Node 26.13.1; pnpm 12.21.0; yt-dlp 2026.10.26; FFmpeg and ffprobe 9.0.2. Official spotDL 4.6.0 was installed in the project-local Python 3.13 environment. Doctor checked actual help output for required options and FFmpeg encoders.

## Evidence collected

- Resolver fixtures cover standalone YouTube, playlist metadata, YouTube/YouTube Music/youtu.be mixed context, selected entries, explicit single/playlist overrides, unavailable entries, Spotify tracks and albums, and metadata-driven generic URL collections.
- Real SQLite/filesystem tests cover persistent jobs, duplicate selections, concurrency, retries, cancellation, restart recovery, no overwrite, ordered playlists and independent device export.
- Process tests exercise literal shell metacharacters, subprocess abort, Unicode chunk boundaries and credential redaction.
- Ink interaction tests exercise universal input, tabs, library filtering, mixed-link prompts/cancellation and playlist creation.
- CLI subprocess tests exercise help, invalid format/URL and persistent queue listing.
- Authorized end-to-end test audio and cover art are generated with FFmpeg. A temporary localhost server supplies them to the actual yt-dlp executable. Outputs are probed with ffprobe, including ID3v2.3 bytes, Unicode tags, cover art, duration, real codec, library/history insertion, M3U paths, duplicate skipping and staging cleanup.
- Live metadata-only YouTube resolution correctly identified video jNQXAC9IVRw with its separate RD playlist context; no audio was downloaded.
- Live metadata-only Spotify album resolution returned all 14 tracks from After Hours. Its parallel metadata response arrived out of order; album track/disc numbers and playlist positions now restore source order.
- Live metadata-only Spotify resolution identified “Blinding Lights” by The Weeknd with album/release/track metadata. No matched audio was downloaded.
- The historical yt-dlp test video BaW_jenozKc returned unavailable, which MusicDL reported without downloading.
- The live dashboard launched in a terminal PTY; individual Tab navigation and Ctrl+C shutdown worked.

The localhost test initially hit the sandbox's bind restriction and was rerun with explicit execution permission. A skipped/blocked test is not counted as a passing integration test.

## Limits

Actual remote audio downloads from YouTube/Spotify matching were not exercised. No credentials or protected/private media were used. Windows/Linux have portable code and a CI matrix but no executed remote CI evidence in this session. Physical Canary playback, filesystem quirks of a mounted SD card, and player artwork limits remain unverified. Device tests used disposable folders. The existing Canary library was not modified.

Final check results and any review fixes are recorded in docs/progress.md.

Final local gate: 70 automated tests across 10 suites, strict source/test typechecks, production build and formatting validation. The user-bin launcher resolves from a login zsh shell and opens the live Ink dashboard. Doctor reports all four tools and required encoders available.
