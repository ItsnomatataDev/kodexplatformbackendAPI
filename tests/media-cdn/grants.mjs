import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import { verifyMediaEdgeRequest } from '../../dist/media-platform/playback/edge-auth.js';

const ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-1111-1111-111111111111';

export async function issuePlaybackGrant(path, secret, redisUrl = process.env.REDIS_URL ?? 'redis://redis:6379') {
  const verified = verifyMediaEdgeRequest({ uri: path, secret });
  if (!verified.valid) return;
  const client = createClient({ url: redisUrl, disableOfflineQueue: true });
  client.on('error', () => undefined);
  await client.connect();
  try {
    const digest = createHash('sha256').update(verified.signature).digest('hex');
    await client.set(
      `kode:development:media-playback-grant:${digest}`,
      JSON.stringify({
        signature: verified.signature,
        assetId: verified.assetId,
        generation: verified.generation ?? null,
        organizationId: ORG_ID,
        userId: USER_ID,
        expiresAt: verified.expiresAt,
      }),
      { PX: 300_000 },
    );
  } finally {
    await client.close();
  }
}
