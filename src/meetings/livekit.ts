import { SignJWT } from 'jose';
import { env } from '../config/env.js';
import { ValidationError } from '../http/errors.js';

export function normalizeLivekitUrl(value: string | undefined | null) {
  if (!value?.trim()) return null;
  const rawValue = value.trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawValue)
    ? rawValue
    : `wss://${rawValue}`;
  const url = new URL(withProtocol);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new ValidationError('LIVEKIT_URL must use wss://, ws://, https://, or http://.');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function isLivekitConfigured() {
  return Boolean(env.livekit.url && env.livekit.apiKey && env.livekit.apiSecret);
}

export async function mintLivekitToken(params: {
  identity: string;
  name: string;
  roomName: string;
  roomAdmin?: boolean;
  canPublishData?: boolean;
}) {
  if (!isLivekitConfigured()) {
    throw new ValidationError('LiveKit token service is not configured.');
  }
  const secret = new TextEncoder().encode(env.livekit.apiSecret);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    video: {
      roomJoin: true,
      room: params.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: params.canPublishData ?? true,
      roomAdmin: Boolean(params.roomAdmin),
    },
    name: params.name,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(env.livekit.apiKey)
    .setSubject(params.identity)
    .setNotBefore(now - 10)
    .setExpirationTime(now + 60 * 60 * 2)
    .sign(secret);

  return {
    token,
    url: normalizeLivekitUrl(env.livekit.url)!,
    roomName: params.roomName,
    identity: params.identity,
    name: params.name,
  };
}
