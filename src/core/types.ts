export type Provider = 'youtube' | 'spotify' | 'ytdlp';
export type AudioFormat = 'mp3' | 'm4a' | 'opus' | 'flac' | 'original';
export interface SourceInfo {
  codec?: string | undefined;
  extension?: string | undefined;
  bitrate?: number | undefined;
  lossless?: boolean | undefined;
}
export interface Track {
  key: string;
  id: string;
  provider: Provider;
  url: string;
  title: string;
  artist?: string | undefined;
  album?: string | undefined;
  albumArtist?: string | undefined;
  releaseDate?: string | undefined;
  trackNumber?: number | undefined;
  discNumber?: number | undefined;
  genre?: string | undefined;
  duration?: number | undefined;
  artworkUrl?: string | undefined;
  isrc?: string | undefined;
  source?: SourceInfo | undefined;
  confidence: 'provider' | 'inferred' | 'manual';
  collectionPosition?: number | undefined;
}
export interface Collection {
  id: string;
  url: string;
  title: string;
  creator?: string | undefined;
  kind: 'playlist' | 'album';
  tracks: Track[];
  totalCount: number;
  unavailableCount: number;
}
export interface CollectionDestination {
  key: string;
  title: string;
  kind: 'playlist' | 'album';
  url: string;
  root: string;
  directory: string;
}
export type ResolvedInput =
  | { kind: 'track'; track: Track }
  | { kind: 'collection'; collection: Collection }
  | { kind: 'context'; track: Track; collectionUrl: string };
export interface Selection {
  tracks: Track[];
  collection?: Collection | undefined;
}
export interface SelectionFlags {
  single?: boolean | undefined;
  playlist?: boolean | undefined;
  yes?: boolean | undefined;
}
export interface Tools {
  ytdlp: string;
  spotdl: string;
  ffmpeg: string;
  ffprobe: string;
}
export type JobStatus =
  'queued' | 'downloading' | 'processing' | 'retrying' | 'completed' | 'failed' | 'cancelled';
export interface Progress {
  percent?: number | undefined;
  speed?: number | undefined;
  eta?: number | undefined;
  stage: string;
}
export interface Job {
  id: string;
  track: Track;
  format: AudioFormat;
  status: JobStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  error?: string | undefined;
  outputPath?: string | undefined;
  fileHash?: string | undefined;
  batchId?: string | undefined;
  progress?: Progress | undefined;
  audioInfo?: { duration: number; codec: string; bitrate: number } | undefined;
  destination?: CollectionDestination | undefined;
}
export interface LibraryTrack {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  codec: string;
  bitrate: number;
  size: number;
  mtime: number;
  sourceKey?: string | undefined;
  isrc?: string | undefined;
  hash?: string | undefined;
}
export interface LocalPlaylist {
  id: string;
  name: string;
  createdAt: number;
}
export interface PlanEntry {
  source: string;
  destination: string;
}
