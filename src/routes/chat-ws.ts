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

      return {
        async onOpen(_event, ws: WSContext) {
          await hub.start();
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

          ws.send(
            JSON.stringify(
              chatEnvelope('presence', {
                userId,
                status: 'online',
              }, { organizationId }),
            ),
          );

          await hub.publish(
            organizationPresenceChannel(organizationId),
            chatEnvelope(
              'presence',
              { userId, status: 'online' },
              { organizationId },
            ),
          );
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

          const type = parsed.type;
          if (type === 'ping') {
            ws.send(JSON.stringify(chatEnvelope('pong', {})));
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
          hub.unregister(connectionId);
          await hub.publish(
            organizationPresenceChannel(organizationId),
            chatEnvelope(
              'presence',
              { userId, status: 'offline' },
              { organizationId },
            ),
          );
        },
      };
    }),
  );

  return routes;
}
