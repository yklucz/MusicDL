# Collection folders and installation implementation plan

> **For agentic workers:** Use test-driven implementation and independent review. Execute the user's supplied specification through verification, commit, push and CI inspection.

**Goal:** Put each selected online collection in its own durable download folder and provide equivalent one-command macOS/Linux and Windows installers.

**Architecture:** Extend existing SQLite jobs with immutable collection destinations. Reserve collision-safe collection directories and scope active deduplication to destinations; reuse compatible indexed audio by copying bytes into staging. Bootstrap Node in native shell wrappers, then run shared dependency, build, launcher and PATH setup code.

**Tech stack:** Existing strict TypeScript, Node SQLite, Vitest, pnpm, official downloader tools; dependency-free installer modules before the application build.

## Global constraints

- Preserve existing settings, music, library databases and download history. Exercise migrations only on disposable databases during development.
- Automatic collection folders default to enabled; a `playlistFolders` boolean disables them without changing standalone behavior.
- Every selected playlist/album track belongs to that collection, including subsets and tracks requested in several collections. Single-video selection does not acquire playlist context.
- No overwrite, deletion, re-encoding of reused audio, shell injection, unapproved privileged installation or security-policy changes.
- Support macOS Apple Silicon/Intel, practical Linux, native Windows x64/ARM64 where dependencies exist; report unsupported combinations.
- Push reviewed changes normally to `origin/main`, retain MIT LICENSE, and inspect all three CI jobs.

## Review focus

- Interrupted jobs must retain the original absolute destination after settings change.
- Existing unowned directories, same-name providers and case-insensitive filesystems must not merge collections.
- A shared recording in concurrent collections must appear in both folders.
- Installer reruns must retain launchers owned by other programs, shell profile content and application settings.
- Missing package managers, network failures and incompatible native binaries must report failure rather than success.

## Task 1: Persistent collection destinations

- [ ] Add failing behavior tests for Spotify/YouTube/YouTube Music, albums, subsets, standalone context, Unicode/sanitization, collisions, format handling, concurrency, cross-collection copies and recovery.
- [ ] Add destination types, additive SQLite migration and destination-scoped active indexes. Existing jobs retain standalone semantics.
- [ ] Reserve provider-identity destinations, persist them on jobs and publish collection audio directly inside them. Copy compatible library audio through exclusive staging; serialize simultaneous downloads of the same recording for reuse.
- [ ] Keep each input's collection association through application selection; deduplicate within each destination instead of across distinct collections.
- [ ] Run focused tests, typecheck and review no-overwrite/recovery paths.

## Task 2: One-command installers

- [ ] Add failing behavioral tests for setup planning, repeatability, failure/confirmation handling, launcher preservation and profile/PATH updates.
- [ ] Create `install.sh`, `install.ps1`, shared installer module(s), and retain existing setup commands as compatible entry points.
- [ ] Detect OS/architecture, bootstrap compatible official Node safely when absent, install pinned pnpm per user, verify FFmpeg/ffprobe, install uv/Python and pinned isolated downloader tools, build, register launchers and run doctor.
- [ ] Confirm system/package-manager changes. Prefer user-scoped verified downloads; never change PowerShell execution policy. Report unsupported dependencies with actionable instructions.
- [ ] Validate wrappers in native CI shells and run repeatable installer checks with disposable directories.

## Task 3: Documentation, release and verification

- [ ] Document one-command setup, prerequisites, platform limits, folder behavior, flat downloads, updating and non-destructive uninstall.
- [ ] Run typechecks, all Vitest tests, Prettier, build and installer checks; independently review the change.
- [ ] Inspect staged text files for private/runtime data, preserve LICENSE, commit, push, and verify macOS/Ubuntu/Windows Actions results.
