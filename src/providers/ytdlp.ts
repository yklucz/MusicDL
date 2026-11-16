import type { Track } from '../core/types.js';
export const ytBaseArgs = [
  '--ignore-config',
  '--no-exec',
  '--no-warnings',
  '--js-runtimes',
  `node:${process.execPath}`,
  '--socket-timeout',
  '30',
  '--retries',
  '2',
];
export function ytMetadataArgs(url: string, collection = false): string[] {
  return [
    ...ytBaseArgs,
    '--skip-download',
    '--dump-single-json',
    ...(collection ? ['--yes-playlist', '--flat-playlist'] : ['--no-playlist']),
    '--',
    url,
  ];
}
export function ytDownloadArgs(track: Track, output: string, lossless = false): string[] {
  return [
    ...ytBaseArgs,
    '--no-playlist',
    '--no-overwrites',
    '--newline',
    '--progress',
    '--no-simulate',
    '--progress-template',
    'download:MUSICDL_PROGRESS %(progress)j',
    '--print',
    'after_move:MUSICDL_FILE %(filepath)j',
    '-f',
    lossless
      ? 'bestaudio[acodec~="^(flac|alac|pcm_|wavpack|ape)"]/best[acodec~="^(flac|alac|pcm_|wavpack|ape)"]/bestaudio[ext=flac]/best[ext=flac]/bestaudio[ext=wav]/best[ext=wav]/bestaudio/best'
      : 'bestaudio/best',
    '-o',
    output,
    '--',
    track.url,
  ];
}
