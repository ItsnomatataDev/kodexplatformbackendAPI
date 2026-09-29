import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { db } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { MinioFileStorage } from '../files/minio-storage.js';
import { playbackEncodingArgs, playbackObjectKey, isPlaybackVideo } from './playback.js';

const files = new MinioFileStorage();
const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop.abort());
const maxBytes = 2 * 1024 ** 3;

async function encode(input: string, output: string, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    // Never run a shell or pass storage URLs/credentials into ffmpeg.
    const child = spawn('ffmpeg', playbackEncodingArgs(input, output), {
      stdio: ['ignore', 'ignore', 'ignore'], signal,
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('encode_failed')));
  });
}

async function prepare(bucket: string, objectKey: string) {
  const key = playbackObjectKey(bucket, objectKey);
  if (await files.headObject(bucket, key)) return;
  const head = await files.headObject(bucket, objectKey);
  if (!head || !head.sizeBytes || head.sizeBytes > maxBytes) throw Error('source_missing_or_too_large');
  const directory = await mkdtemp(join(tmpdir(), 'kode-playback-'));
  const started = Date.now();
  try {
    const source = await files.getObjectStream(bucket, objectKey);
    if (!source || source.status !== 200) throw Error('source_unavailable');
    const input = join(directory, 'source');
    const output = join(directory, 'playback.mp4');
    let bytes = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? Error('source_too_large') : null, chunk);
    } });
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(30 * 60_000)]);
    await pipeline(Readable.fromWeb(source.body as import('node:stream/web').ReadableStream), limit, createWriteStream(input), { signal });
    await encode(input, output, signal);
    const size = (await stat(output)).size;
    if (size === 0 || size > maxBytes) throw Error('invalid_output_size');
    // Publish only after encoding and fast-start finalization finish successfully.
    await files.putObjectStream({ bucket, objectKey: key, contentType: 'video/mp4',
      contentLength: size, body: Readable.toWeb(createReadStream(output)) as ReadableStream<Uint8Array> });
    logger.info({ playbackId: key.split('/').pop(), sourceBytes: bytes, playbackBytes: size,
      durationMs: Date.now() - started }, 'media.playback.ready');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

try {
  while (!stop.signal.aborted) {
    // One worker across deployments. Session lock stays on a dedicated connection.
    const lock = await db.connect();
    try {
      const acquired = await lock.query('SELECT pg_try_advisory_lock(71402819) AS locked');
      if (acquired.rows[0]?.locked) {
        let after = '';
        while (!stop.signal.aborted) {
          const result = await lock.query<{ bucket: string; storage_path: string }>(`
            SELECT bucket, storage_path FROM (
              SELECT bucket, storage_path FROM content.schedule_assets WHERE asset_type = 'video'
              UNION SELECT bucket, storage_path FROM content.client_media WHERE asset_type = 'video'
            ) media WHERE storage_path IS NOT NULL AND bucket || '/' || storage_path > $1
            ORDER BY bucket || '/' || storage_path LIMIT 50`, [after]);
          if (!result.rows.length) break;
          for (const row of result.rows) {
            if (stop.signal.aborted) break;
            after = `${row.bucket}/${row.storage_path}`;
            if (!isPlaybackVideo(row.storage_path)) continue;
            try { await prepare(row.bucket, row.storage_path); }
            catch { logger.warn({ playbackId: playbackObjectKey(row.bucket, row.storage_path).split('/').pop() }, 'media.playback.failed'); }
          }
        }
      }
    } finally {
      await lock.query('SELECT pg_advisory_unlock(71402819)').catch(() => {});
      lock.release();
    }
    await delay(300_000, undefined, { signal: stop.signal }).catch(() => {});
  }
} finally { await db.end(); }
