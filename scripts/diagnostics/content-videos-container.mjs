// Run on the VPS: docker exec -i kode-vps-api node --input-type=module < scripts/diagnostics/content-videos-container.mjs
// Read-only, bounded samples. No capability URLs, credentials or object names.
const { db } = await import('/app/dist/db/pool.js');
const { MinioFileStorage } = await import('/app/dist/files/minio-storage.js');
const storage = new MinioFileStorage();
try {
  const { rows } = await db.query(`SELECT id, schedule_id, bucket, storage_path
    FROM content.schedule_assets WHERE asset_type = 'video' OR mime_type LIKE 'video/%'
    ORDER BY created_at DESC LIMIT 5`);
  for (const row of rows) {
    if (!row.storage_path) continue;
    for (const range of ['bytes=0-65535', 'bytes=-65536']) {
      const started = performance.now();
      try {
        const stream = await storage.getObjectStream(row.bucket, row.storage_path, range);
        const headersMs = Math.round(performance.now() - started);
        if (!stream) {
          console.log(JSON.stringify({ assetId: row.id, scheduleId: row.schedule_id, range, outcome: 'missing' }));
          continue;
        }
        const reader = stream.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          while (bytes < 65536) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = Buffer.from(next.value).subarray(0, 65536 - bytes);
            chunks.push(chunk);
            bytes += chunk.length;
          }
        } finally { await reader.cancel(); }
        const sample = Buffer.concat(chunks);
        console.log(JSON.stringify({ assetId: row.id, scheduleId: row.schedule_id,
          range, status: stream.status, contentRange: stream.contentRange,
          contentLength: stream.contentLength, contentType: stream.contentType,
          objectBytes: stream.sizeBytes, sampledBytes: bytes, headersMs,
          totalMs: Math.round(performance.now() - started),
          // Hints only: this is not a full container parser or decode benchmark.
          markers: ['ftyp', 'moov', 'mdat', 'avc1', 'hvc1', 'hev1'].filter((value) => sample.includes(Buffer.from(value))),
        }));
      } catch {
        console.log(JSON.stringify({ assetId: row.id, range, outcome: 'storage_error', totalMs: Math.round(performance.now() - started) }));
      }
    }
  }
} finally { await db.end(); }
