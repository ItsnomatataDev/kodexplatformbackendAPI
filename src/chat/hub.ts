import { createClient, type RedisClientType } from 'redis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { redisClientOptions } from '../auth/rate-limit-redis.js';
import type { ChatRealtimeEnvelope } from './events.js';
import { conversationChannel } from './events.js';

export type ChatSocketClient = {
  send: (data: string) => void;
  readyState?: number;
};

type LocalConnection = {
  socket: ChatSocketClient;
  userId: string;
  organizationId: string;
  conversations: Set<string>;
};


export class ChatRealtimeHub {
  private readonly connections = new Map<string, LocalConnection>();
  private publisher: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private started = false;

  async start() {
    if (this.started) return;
    this.started = true;

    try {
      const options = redisClientOptions({
        appEnv: env.appEnv,
        host: env.redis.host,
        port: env.redis.port,
        username: env.redis.username,
        password: env.redis.password,
        tls: env.redis.tls,
        rejectUnauthorized: env.redis.rejectUnauthorized,
        ca: env.redis.ca,
      });
      this.publisher = createClient(options) as RedisClientType;
      this.subscriber = createClient(options) as RedisClientType;
      this.publisher.on('error', (err) => {
        logger.warn({ err }, 'Chat Redis publisher error');
      });
      this.subscriber.on('error', (err) => {
        logger.warn({ err }, 'Chat Redis subscriber error');
      });
      await this.publisher.connect();
      await this.subscriber.connect();
      await this.subscriber.pSubscribe('chat:*', (message, channel) => {
        this.deliverLocal(channel, message);
      });
      logger.info('Chat realtime hub connected to Redis pub/sub');
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Chat realtime hub running without Redis (local fan-out only)',
      );
      this.publisher = null;
      this.subscriber = null;
    }
  }

  async stop() {
    try {
      await this.subscriber?.pUnsubscribe('chat:*');
      await this.subscriber?.quit();
      await this.publisher?.quit();
    } catch {
      // ignore shutdown races
    }
    this.subscriber = null;
    this.publisher = null;
    this.connections.clear();
    this.started = false;
  }

  register(connectionId: string, connection: LocalConnection) {
    this.connections.set(connectionId, connection);
  }

  unregister(connectionId: string) {
    this.connections.delete(connectionId);
  }

  subscribeConversation(connectionId: string, conversationId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.conversations.add(conversationId);
  }

  unsubscribeConversation(connectionId: string, conversationId: string) {
    this.connections.get(connectionId)?.conversations.delete(conversationId);
  }

  async publish(channel: string, envelope: ChatRealtimeEnvelope) {
    const raw = JSON.stringify(envelope);
    if (this.publisher?.isOpen) {
      try {
        await this.publisher.publish(channel, raw);
        return;
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            channel,
          },
          'Chat Redis publish failed; falling back to local fan-out',
        );
      }
    }
    this.deliverLocal(channel, raw);
  }

  async publishToConversation(
    conversationId: string,
    envelope: ChatRealtimeEnvelope,
  ) {
    await this.publish(conversationChannel(conversationId), envelope);
  }

  private deliverLocal(channel: string, raw: string) {
    let envelope: ChatRealtimeEnvelope;
    try {
      envelope = JSON.parse(raw) as ChatRealtimeEnvelope;
    } catch {
      return;
    }

    for (const connection of this.connections.values()) {
      if (channel.startsWith('chat:conversation:')) {
        const conversationId = channel.slice('chat:conversation:'.length);
        if (!connection.conversations.has(conversationId)) continue;
      } else if (channel.startsWith('chat:presence:')) {
        const organizationId = channel.slice('chat:presence:'.length);
        if (connection.organizationId !== organizationId) continue;
      } else {
        continue;
      }

      try {
        connection.socket.send(JSON.stringify(envelope));
      } catch {
        // drop dead sockets; cleanup happens on close
      }
    }
  }
}

let hubSingleton: ChatRealtimeHub | null = null;

export function getChatRealtimeHub() {
  if (!hubSingleton) {
    hubSingleton = new ChatRealtimeHub();
  }
  return hubSingleton;
}
