/** Read-only: sample stored videos, verify existence and byte-range streaming; never copies originals. */
import { db } from '../../src/db/pool.js';
import { env } from '../../src/config/env.js';
import { MinioFileStorage } from '../../src/files/minio-storage.js';

const limit = Math.min(50, Math.max(1, Number(process.argv[2]) || 10));
const files = new MinioFileStorage();
try {
  console.log(JSON.stringify({ target: { databaseHost: env.database.host, database: env.database.name, storageEndpoint: new URL(env.minio.endpoint).host }, limit }));
  const result = await db.query<{
    id: string; schedule_id: string; bucket: string; storage_path: string | null;
    mime_type: string | null; stored_size_bytes: string | null; web_playback_status: string | null;
  }>(`SELECT id, schedule_id, bucket, storage_path, mime_type, stored_size_bytes, web_playback_status
      FROM content.schedule_assets
      WHERE asset_type = 'video' OR mime_type LIKE 'video/%'
      ORDER BY created_at DESC LIMIT $1`, [limit]);
  for (const row of result.rows) {
    const base = { assetId: row.id, scheduleId: row.schedule_id, mimeType: row.mime_type, playbackStatus: row.web_playback_status };
    if (!row.storage_path) { console.log(JSON.stringify({ ...base, error: 'missing_storage_path' })); continue; }
    try {
      const started = Date.now();
      const head = await files.headObject(row.bucket, row.storage_path);
      if (!head) { console.log(JSON.stringify({ ...base, error: 'object_missing_in_minio' })); continue; }
      const probes = [];
      for (const range of ['bytes=0-65535', 'bytes=-65536']) {
        const stream = await files.getObjectStream(row.bucket, row.storage_path, range);
        if (!stream) { probes.push({ range, error: 'object_missing' }); continue; }
        const reader = stream.body.getReader();
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          while (size < 65536) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = Buffer.from(next.value).subarray(0, 65536 - size);
            chunks.push(chunk); size += chunk.length;
          }
        } finally { await reader.cancel(); }
        const bytes = Buffer.concat(chunks);
        probes.push({ range, status: stream.status, contentRange: stream.contentRange,
          contentType: stream.contentType, sampledBytes: size,
          // Markers are hints, not a full codec probe.
          containerMarkers: ['ftyp', 'moov', 'mdat', 'avc1', 'hvc1', 'hev1'].filter((marker) => bytes.includes(Buffer.from(marker))) });
      }
      console.log(JSON.stringify({ ...base, sizeBytes: head.sizeBytes, storedMimeType: head.contentType,
        metadataSizeMatches: row.stored_size_bytes == null ? null : Number(row.stored_size_bytes) === head.sizeBytes,
        elapsedMs: Date.now() - started, probes }));
    } catch (error) { console.log(JSON.stringify({ ...base, error: error instanceof Error ? error.message : 'probe_failed' })); }
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'diagnostics_failed' }));
  process.exitCode = 1;
} finally { await db.end(); }
