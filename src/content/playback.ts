import { createHash } from 'node:crypto';
import type { FileStorage } from '../files/storage.js';

/** Versioned, immutable derivatives. Original keys contain upload UUIDs. */
export function playbackObjectKey(bucket: string, original: string) {
  return `.playback/v1/${createHash('sha256').update(`${bucket}\0${original}`).digest('hex')}.mp4`;
}

export function isPlaybackVideo(key: string) {
  return /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(key);
}

/** Call only AFTER original-object authorization. Never authorize by derivative key. */
export async function resolvePlaybackObject(files: FileStorage, bucket: string, original: string) {
  if (!files.headObject || !isPlaybackVideo(original)) return original;
  const key = playbackObjectKey(bucket, original);
  const head = await files.headObject(bucket, key);
  return head && (head.sizeBytes ?? 0) > 0 ? key : original;
}

/** CPU, resolution, frame rate and bitrate limits apply independently of input. */
export function playbackEncodingArgs(input: string, output: string) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-maxrate', '3000k', '-bufsize', '6000k',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level:v', '4.1', '-threads', '2',
    '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', output];
}
