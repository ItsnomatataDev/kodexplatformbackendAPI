import { Client } from 'minio';
import { Agent } from 'node:https';
import { extname } from 'node:path';
import { env } from '../config/env.js';
import { ServiceUnavailableError } from '../http/errors.js';
import type { PlaybackRow } from './schedule-playback-store.js';

export const PLAYBACK_URL_TTL_SECONDS = 6 * 60 * 60;
export const PLAYBACK_CACHE_CONTROL = 'public, max-age=31536000';
export type SignedPlaybackAsset = {
  id: string;
  type: 'video' | 'image';
  url: string;
  duration?: number;
};
export type PlaybackSigner = (asset: PlaybackRow) => Promise<SignedPlaybackAsset>;

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.avif': 'image/avif', '.svg': 'image/svg+xml',
};

export function createPlaybackSigner(client: Pick<Client, 'presignedGetObject'>): PlaybackSigner {
  return async (asset) => {
    const storedMime = asset.mime_type?.split(';')[0]?.trim().toLowerCase();
    const mime = storedMime?.startsWith(`${asset.type}/`)
      ? storedMime : MIME_TYPES[extname(asset.storage_path).toLowerCase()];
    const headers: Record<string, string> = {
      'response-cache-control': PLAYBACK_CACHE_CONTROL,
    };
    // If unknown, preserve the object's existing Content-Type in MinIO.
    if (mime?.startsWith(`${asset.type}/`)) headers['response-content-type'] = mime;
    const url = await client.presignedGetObject(
      asset.bucket, asset.storage_path, PLAYBACK_URL_TTL_SECONDS, headers,
    );
    return { id: asset.id, type: asset.type, url,
      ...(asset.type === 'image' ? { duration: 7 } : {}) };
  };
}

// Lazy construction allows development without configured object storage.
export function defaultPlaybackSigner(): PlaybackSigner {
  let sign: PlaybackSigner | undefined;
  return async (asset) => {
    if (!sign) {
      if (!env.minio.accessKey || !env.minio.secretKey) {
        throw new ServiceUnavailableError('OBJECT_STORAGE_UNAVAILABLE', 'MinIO signing is not configured.');
      }
      const endpoint = new URL(process.env.MINIO_PUBLIC_ENDPOINT || env.minio.endpoint);
      if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' ||
          endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
        throw new ServiceUnavailableError('OBJECT_STORAGE_UNAVAILABLE', 'MinIO playback requires a public HTTPS origin.');
      }
      sign = createPlaybackSigner(new Client({
        endPoint: endpoint.hostname,
        port: endpoint.port ? Number(endpoint.port) : 443,
        useSSL: true,
        region: process.env.MINIO_REGION || 'us-east-1',
        accessKey: env.minio.accessKey,
        secretKey: env.minio.secretKey,
        transportAgent: new Agent({ keepAlive: true, ca: env.minio.ca }),
      }));
    }
    return sign(asset);
  };
}
