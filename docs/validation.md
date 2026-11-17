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

## Collection destinations and one-command installation (2026-11-17)

Collection tests cover provider title routing for Spotify, YouTube, YouTube Music and albums; configured formats; Unicode and reserved names; occupied/same-name/case-equivalent folders; subsets and single-video selection; multiple pasted collections sharing tracks; persistence/recovery after settings changes; safe compatible copies; relative M3U8 references; and additive migration of a version-three fixture database. Real FFmpeg-generated tagged MP3 files with embedded artwork were copied into two collection folders and compared byte for byte; original audio stayed intact.

Installer tests exercise native Node selection/bootstrap, verified binary acquisition, frozen dependencies/build, repeatability, doctor isolation, explicit system-change refusal/confirmation, profile content retention, unrelated/legacy launcher handling, failure reporting and platform-specific behavior. A complete actual Apple Silicon installation in a disposable Unicode-path checkout ran twice with real native pnpm, managed Python 3.13, spotDL 4.6.0, yt-dlp 2026.10.26, dependency installation, production build, isolated doctor and installed launcher checks. The real home, settings and database were not opened or changed. No privileged system installation was run during development.

Independent review found and corrected Windows launcher encoding under non-UTF8 consoles, read-only check permissions and Bash bootstrap staging cleanup. Native Windows regression checks force CP437 and check code-page restoration. The GitHub workflow additionally runs actual isolated installation, rerun, Unicode-path launcher and doctor checks on all three disposable OS runners; this exercises package compatibility in addition to unit fixtures. Native Intel macOS and Windows ARM64 remain untested hardware targets; Windows ARM64 requires an existing native FFmpeg installation and compatible Python dependencies.

The first remote installation checks exposed a public GitHub API rate limit while acquiring uv and incorrect argument escaping in native Windows launcher test invocations. Setup now downloads the official versioned uv release archive and its published SHA256 companion directly, verifies the exact archive name and digest, and does not need an API token. A live public download, native execution and offline reuse check passed. Windows command-interpreter invocations preserve the manually constructed command tail; Unicode and CP437 assertions remain intact.

Final local verification: strict source/test typechecks, production build and Prettier passed; 153 tests passed and two native-Windows-only tests were skipped on macOS, across 15 suites. Bash syntax/help and installer smoke-script syntax checks passed. Final remote CI results are reported with the delivered commit.
