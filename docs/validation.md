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

Actual remote audio downloads from YouTube/Spotify matching were not exercised. No credentials or protected/private media were used. Physical Canary playback, filesystem quirks of a mounted SD card, and player artwork limits remain unverified. Device tests used disposable folders. The existing Canary library was not modified.

Final check results and any review fixes are recorded in docs/progress.md.

Initial local gate: 70 automated tests across 10 suites, strict source/test typechecks, production build and formatting validation. The user-bin launcher resolves from a login zsh shell and opens the live Ink dashboard. Doctor reports all four tools and required encoders available.

## Spotify loading and cross-platform CI fixes (2026-11-17)

The installed spotDL 4.6.0 help and source were inspected. Its `save` command collects the full response before writing JSON, performs a YouTube Music connectivity check by default, reinitializes playlist tracks with individual metadata requests, and requests lyrics. Its playlist parser can stop on a failed page or omit failed songs. This is provider/subprocess work with no streamed metadata, while the original UI showed only a static note. Raising a timeout alone does not address it.

Metadata-only probes of the reported 13-track public playlist reproduced the long wait: the original invocation remained silent through a 45-second diagnostic deadline. Disabling the unrelated probe and lyrics reported 13 songs after about 34 seconds but still did not finish within 180 seconds. The SDK page adapter subsequently completed in 19 seconds, returning all 13 source positions, album names and artwork URLs. The user's playlist identity and song names are intentionally not recorded here.

A separate public 1,000-entry collection completed in 12 seconds, reporting pages at 343, 686 and 1,000. The provider explicitly marked 100 entries unavailable; all 900 accessible entries retained album names and cover URLs, and their original source positions include the unavailable gaps. These are individual observed timings, not performance guarantees. A live Spotify track metadata probe also completed with artwork in 75 seconds. No audio was downloaded during these checks.

Live one-second timeout and cancellation probes both terminated the playlist subprocess and cleared progress with the expected `TIMEOUT` and `CANCELLED` codes. Deterministic tests cover silent-provider heartbeats, keyboard navigation/cancellation without queueing, 1,000-entry pagination, changed totals/revisions, incorrect offsets, truncated and malformed pages, explicit unavailable entries, provider failure, sanitized diagnostics and temporary metadata cleanup. Only the public SDK already supplied by spotDL is used; access checks are retained. Unknown SDK exceptions expose the exception class rather than raw HTTP bodies or headers. Unsupported SDK versions fail with setup guidance.

The Windows playlist creation failure was reproduced by sending terminal input before the next Ink prompt had committed. UI tests now wait on Ink's render flush and the actual prompt, preserving the database and order assertions. In [the first fix run](https://github.com/yklucz/MusicDL/actions/runs/43995550855), macOS and Ubuntu passed, and Windows passed all 70 tests including playlist creation. Its later formatting step exposed CRLF checkout differences; `.gitattributes` now enforces LF. macOS logs confirmed native ARM64 with Homebrew FFmpeg and ffprobe. Final verification and the final workflow result are reported with the delivered commit.

Local fix verification: 93 Vitest tests across 13 suites passed, including the real generated-audio integration tests and four deterministic Python paging cases. Strict source/test typechecks, production build and formatting checks passed. The built launcher uses the updated resolver after restarting MusicDL. Existing settings, downloads, local playlists and library data were not altered by these changes or probes.
