import path from 'node:path';
import { copyFile, mkdtemp, rm, writeFile, lstat } from 'node:fs/promises';
import type { LibraryTrack, PlanEntry } from '../core/types.js';
import {
  ensureSafeParent,
  exists,
  expandPath,
  publishExclusive,
  safeSegment,
} from '../core/safety.js';
import { MusicDLError } from '../core/errors.js';
import { renderM3u } from '../playlists.js';

export interface ExportOptions {
  kind: 'folder' | 'canary3ds';
  playlistName?: string | undefined;
}
export interface ExportPlan {
  root: string;
  entries: PlanEntry[];
  tracks: LibraryTrack[];
  kind: ExportOptions['kind'];
  playlistPath?: string | undefined;
  playlistText?: string | undefined;
}
export interface DeviceAdapter {
  id: string;
  plan(tracks: LibraryTrack[], root: string, playlistName?: string): ExportPlan;
}
export const adapters: DeviceAdapter[] = [
  {
    id: 'folder',
    plan: (tracks, root, playlistName) =>
      planExport(tracks, root, { kind: 'folder', playlistName }),
  },
  {
    id: 'canary3ds',
    plan: (tracks, root, playlistName) =>
      planExport(tracks, root, { kind: 'canary3ds', playlistName }),
  },
];
export function planExport(
  tracks: LibraryTrack[],
  root: string,
  options: ExportOptions,
): ExportPlan {
  const destinationRoot = expandPath(root),
    destinations = new Set<string>();
  const entries = tracks.map((track) => {
    if (
      options.kind === 'canary3ds' &&
      (track.codec !== 'mp3' || path.extname(track.path).toLowerCase() !== '.mp3')
    )
      throw new MusicDLError(
        'Canary3DS export requires MP3 files. Download or convert MP3 copies first.',
        'FORMAT',
      );
    const folder =
      options.kind === 'canary3ds'
        ? path.join(destinationRoot, 'Music', 'MusicDL')
        : destinationRoot;
    const destination = path.join(
      folder,
      `${safeSegment(`${track.title} - ${track.artist}`)}${path.extname(track.path).toLowerCase()}`,
    );
    const key = destination.toLocaleLowerCase();
    if (destinations.has(key))
      throw new MusicDLError(
        'Two tracks would have the same export filename. Correct the metadata first.',
        'COLLISION',
      );
    destinations.add(key);
    return { source: track.path, destination };
  });
  const playlistPath = options.playlistName
    ? options.kind === 'canary3ds'
      ? path.join(
          destinationRoot,
          '3ds',
          'Canary',
          'Playlists',
          `${safeSegment(options.playlistName)}.m3u`,
        )
      : path.join(destinationRoot, `${safeSegment(options.playlistName)}.m3u8`)
    : undefined;
  const outputTracks = tracks.map((track, i) => ({ ...track, path: entries[i]!.destination }));
  const playlistText = playlistPath
    ? renderM3u(
        outputTracks,
        path.dirname(playlistPath),
        true,
        options.kind === 'canary3ds'
          ? (track) =>
              `sdmc:/${path.relative(destinationRoot, track.path).split(path.sep).join('/')}`
          : undefined,
      )
    : undefined;
  return { root: destinationRoot, entries, tracks, kind: options.kind, playlistPath, playlistText };
}
export async function executeExport(plan: ExportPlan): Promise<void> {
  for (const entry of plan.entries) {
    if (await exists(entry.destination))
      throw new MusicDLError(`Export destination already exists: ${entry.destination}`, 'EXISTS');
    const stats = await lstat(entry.source);
    if (!stats.isFile() || stats.isSymbolicLink())
      throw new MusicDLError('Export source is not a regular file.', 'UNSAFE_PATH');
  }
  if (plan.playlistPath && (await exists(plan.playlistPath)))
    throw new MusicDLError(`Playlist already exists: ${plan.playlistPath}`, 'EXISTS');
  await ensureSafeParent(plan.root, path.join(plan.root, 'placeholder'));
  const staging = await mkdtemp(path.join(plan.root, '.musicdl-export-'));
  try {
    for (let i = 0; i < plan.entries.length; i++) {
      const entry = plan.entries[i]!;
      await ensureSafeParent(plan.root, entry.destination);
      const temp = path.join(staging, `track-${i}`);
      await copyFile(entry.source, temp);
      await publishExclusive(temp, entry.destination);
    }
    if (plan.playlistPath && plan.playlistText) {
      await ensureSafeParent(plan.root, plan.playlistPath);
      await writeFile(plan.playlistPath, plan.playlistText, { flag: 'wx' });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
