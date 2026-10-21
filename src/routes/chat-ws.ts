import { CHAT_HEARTBEAT_MS, CHAT_PRESENCE_TTL_MS } from '../chat/presence.js';
import { logger } from '../config/logger.js';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { upgradeWebSocket } from '@hono/node-server';
import type { WSContext } from 'hono/ws';
import type { AuthDependencies } from '../auth/middleware.js';
import { extractBearerToken } from '../auth/credential.js';
import { assertAuthenticatedAccount } from '../auth/account.js';
import { UnauthorizedError } from '../http/errors.js';
import type { ChatStore } from '../chat/store.js';
import { chatEnvelope } from '../chat/events.js';
import { getChatRealtimeHub } from '../chat/hub.js';
import { organizationPresenceChannel } from '../chat/events.js';

export type ChatWsDependencies = {
  auth: AuthDependencies;
  store: ChatStore;
};

export function readAccessToken(c: {
  req: { query: (name: string) => string | undefined; header: (name: string) => string | undefined };
}) {
  const fromQuery = c.req.query('access_token') ?? c.req.query('token');
  if (fromQuery) return fromQuery;
  const extracted = extractBearerToken(c.req.header('authorization'));
  return extracted.ok ? extracted.token : null;
}

export function createChatWebSocketRoutes(dependencies: ChatWsDependencies) {
  const routes = new Hono();
  const hub = getChatRealtimeHub();

  routes.get(
    '/',
    upgradeWebSocket(async (c) => {
      const token = readAccessToken(c);
      if (!token) {
        throw new UnauthorizedError(
          'WS_TOKEN_REQUIRED',
          'WebSocket access_token is required.',
        );
      }

      const verified = await dependencies.auth.verifier.verify(token);
      if (!verified.sessionId) {
        throw new UnauthorizedError(
          'SESSION_REQUIRED',
          'A valid session is required.',
        );
      }
      await dependencies.auth.requireActiveSession(
        verified.sessionId,
        verified.userId,
      );
      const auth = await dependencies.auth.resolveAuthContext(verified.userId);
      assertAuthenticatedAccount(auth);

      const connectionId = randomUUID();
      const organizationId = auth.membership.organizationId;
      const userId = auth.actor.userId;

      let watchedUsers: string[] = [];
      let lastHeartbeat = Date.now();
      let expiryTimer: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      let presenceWork = Promise.resolve();
      const updatePresence = (action: 'touch' | 'close') => {
        presenceWork = presenceWork.then(async () => {
          if (action === 'touch' && closed) return;
          try {
            const presence = await hub.presence.update(organizationId, userId, connectionId, action);
            await hub.publish(organizationPresenceChannel(organizationId),
              chatEnvelope('presence', presence, { organizationId }));
          } catch (err) {
            logger.warn({ err }, 'Chat presence unavailable');
            await hub.publish(organizationPresenceChannel(organizationId),
              chatEnvelope('presence', { userId, status: 'unknown', lastSeenAt: null }, { organizationId }));
          }
        });
        return presenceWork;
      };
      const snapshot = async (ws: WSContext) => {
        try {
          const users = await hub.presence.snapshot(organizationId, watchedUsers);
          ws.send(JSON.stringify(chatEnvelope('presence.snapshot', { users }, { organizationId })));
        } catch {
          ws.send(JSON.stringify(chatEnvelope('presence.snapshot', {
            users: watchedUsers.map(userId => ({ userId, status: 'unknown', lastSeenAt: null })),
          }, { organizationId })));
        }
      };

      return {
        async onOpen(_event, ws: WSContext) {
          await hub.start();
          if (closed) return;
          hub.register(connectionId, {
            socket: {
              send: (data) => {
                ws.send(data);
              },
            },
            userId,
            organizationId,
            conversations: new Set(),
          });

          expiryTimer = setInterval(() => {
            if (Date.now() - lastHeartbeat >= CHAT_PRESENCE_TTL_MS) ws.close(4000, 'Heartbeat expired');
          }, 5_000);
          expiryTimer.unref();
          if (!closed) await updatePresence('touch');
          ws.send(JSON.stringify(chatEnvelope('presence.ready', {
            heartbeatMs: CHAT_HEARTBEAT_MS, ttlMs: CHAT_PRESENCE_TTL_MS,
          }, { organizationId })));

        },

        async onMessage(event, ws: WSContext) {
          let parsed: {
            type?: string;
            conversationId?: string;
            payload?: Record<string, unknown>;
          };
          try {
            parsed = JSON.parse(String(event.data)) as typeof parsed;
          } catch {
            ws.send(
              JSON.stringify(
                chatEnvelope('error', { message: 'Invalid JSON frame.' }),
              ),
            );
            return;
          }

          if (closed) return;
          const type = parsed.type;
          if (type === 'ping') {
            try {
              await dependencies.auth.requireActiveSession(verified.sessionId!, userId);
            } catch {
              ws.close(4001, 'Session expired');
              return;
            }
            lastHeartbeat = Date.now();
            await updatePresence('touch');
            ws.send(JSON.stringify(chatEnvelope('pong', {})));
            await snapshot(ws);
            return;
          }

          if (type === 'presence.subscribe') {
            const ids = parsed.payload?.userIds;
            if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
              ws.send(JSON.stringify(chatEnvelope('error', { message: 'Invalid presence user IDs (maximum 200).' })));
              return;
            }
            watchedUsers = [...new Set(ids as string[])];
            await snapshot(ws);
            return;
          }

          if (type === 'subscribe' && parsed.conversationId) {
            const conversationId = parsed.conversationId;
            const isMember = await dependencies.store.isMember(
              conversationId,
              userId,
            );
            if (!isMember) {
              ws.send(
                JSON.stringify(
                  chatEnvelope('error', {
                    message: 'Not a member of this conversation.',
                    conversationId,
                  }),
                ),
              );
              return;
            }
            hub.subscribeConversation(connectionId, conversationId);
            ws.send(
              JSON.stringify(
                chatEnvelope(
                  'subscribe',
                  { ok: true, conversationId },
                  { conversationId, organizationId },
                ),
              ),
            );
            return;
          }

          if (type === 'unsubscribe' && parsed.conversationId) {
            hub.unsubscribeConversation(connectionId, parsed.conversationId);
            return;
          }

          if (type === 'typing' && parsed.conversationId) {
            const conversationId = parsed.conversationId;
            const isMember = await dependencies.store.isMember(
              conversationId,
              userId,
            );
            if (!isMember) return;
            await hub.publishToConversation(
              conversationId,
              chatEnvelope(
                'typing',
                {
                  userId,
                  isTyping: Boolean(parsed.payload?.isTyping ?? true),
                },
                { conversationId, organizationId },
              ),
            );
          }
        },

        async onClose() {
          closed = true;
          clearInterval(expiryTimer);
          hub.unregister(connectionId);
          await updatePresence('close');
        },
      };
    }),
  );

  return routes;
}
