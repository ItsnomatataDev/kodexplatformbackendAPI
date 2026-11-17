import type { NotificationRecord } from './store.js';
import type { PostgresPushSubscriptionStore } from './push-store.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_TOKEN_PREFIX = 'ExponentPushToken[';
const EXPO_ENDPOINT_PREFIX = 'expo:';

function toExpoToken(endpoint: string) {
  const trimmed = endpoint.trim();
  if (trimmed.startsWith(EXPO_ENDPOINT_PREFIX)) {
    return trimmed.slice(EXPO_ENDPOINT_PREFIX.length);
  }
  return trimmed;
}

function isExpoPushToken(token: string) {
  return token.startsWith(EXPO_TOKEN_PREFIX) || token.startsWith('ExpoPushToken[');
}

function buildPushMessage(notification: NotificationRecord, to: string) {
  const metadata =
    notification.metadata && typeof notification.metadata === 'object'
      ? notification.metadata
      : {};
  const isCall =
    notification.entityType === 'call' ||
    notification.type === 'call_audio' ||
    notification.type === 'call_video' ||
    notification.category === 'call';
  const channelId =
    typeof metadata.channelId === 'string'
      ? metadata.channelId
      : isCall
        ? 'calls_ring_v1'
        : 'default';
  const sound =
    typeof metadata.sound === 'string'
      ? metadata.sound.replace(/\.wav$/i, '')
      : isCall
        ? 'incoming_call'
        : 'default';

  return {
    to,
    title: notification.title,
    body: notification.message ?? notification.title,
    sound,
    channelId,
    priority: 'high' as const,
    data: {
      notificationId: notification.id,
      entityType: notification.entityType,
      entityId: notification.entityId,
      type: notification.type,
      category: notification.category,
      actionUrl: notification.actionUrl,
      ...metadata,
    },
  };
}

export async function sendExpoPushForNotification(params: {
  notification: NotificationRecord;
  pushStore: PostgresPushSubscriptionStore;
}) {
  const subscriptions = await params.pushStore.listActiveEndpointsForUsers([
    params.notification.recipientUserId,
  ]);
  if (subscriptions.length === 0) return { sent: 0 };

  const messages = subscriptions
    .map((row) => {
      const token = toExpoToken(row.endpoint);
      if (!isExpoPushToken(token)) return null;
      return {
        endpoint: row.endpoint,
        message: buildPushMessage(params.notification, token),
      };
    })
    .filter(Boolean) as Array<{
    endpoint: string;
    message: ReturnType<typeof buildPushMessage>;
  }>;

  if (messages.length === 0) return { sent: 0 };

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(messages.map((item) => item.message)),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.warn(
      `[push] Expo push failed (${response.status}): ${text.slice(0, 300)}`,
    );
    return { sent: 0 };
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: Array<{ status?: string; details?: { error?: string } }>;
  } | null;

  const tickets = payload?.data ?? [];
  for (let i = 0; i < tickets.length; i += 1) {
    const ticket = tickets[i];
    const endpoint = messages[i]?.endpoint;
    if (
      ticket?.status === 'error' &&
      ticket.details?.error === 'DeviceNotRegistered' &&
      endpoint
    ) {
      await params.pushStore.deactivateEndpoint(endpoint);
    }
  }

  return { sent: messages.length };
}
