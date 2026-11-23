import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { mintLivekitToken, isLivekitConfigured } from '../meetings/livekit.js';
import type { PostgresMeetingsStore } from '../meetings/postgres-store.js';
import type { NotificationStore } from '../notifications/store.js';
import { requireProductOrg } from '../products/staff.js';
import { readJson, readRequiredText, requireUuidValue } from '../work/http.js';

export type CallsRouteDependencies = {
  store: PostgresMeetingsStore;
  notifications: NotificationStore;
};

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

function generateE2eePassphrase() {
  return randomBytes(32).toString('hex');
}

function mapCall(meeting: NonNullable<Awaited<ReturnType<PostgresMeetingsStore['getMeeting']>>>) {
  return {
    id: meeting.id,
    organization_id: meeting.organization_id,
    conversation_id: meeting.conversation_id,
    caller_id: meeting.host_id,
    call_type: meeting.meeting_type,
    status: meeting.status,
    livekit_room_name: meeting.livekit_room_name,
    started_at: meeting.started_at,
    ended_at: meeting.ended_at,
    created_at: meeting.created_at,
    title: meeting.title,
    host_id: meeting.host_id,
    meeting_type: meeting.meeting_type,
    participants: meeting.participants ?? [],
  };
}

async function notifyCallInvite(params: {
  notifications: NotificationStore;
  organizationId: string;
  actorUserId: string;
  actorEmail?: string | null;
  userIds: string[];
  callId: string;
  callType: 'audio' | 'video';
  conversationId?: string | null;
}) {
  const uniqueIds = [...new Set(params.userIds.filter(Boolean))];
  if (uniqueIds.length === 0) return;

  const displayName = await params.notifications.getDisplayName(params.actorUserId);
  const callerName =
    displayName?.trim() ||
    params.actorEmail?.split('@')[0]?.trim() ||
    'Someone';
  const type = params.callType === 'video' ? 'call_video' : 'call_audio';
  const title =
    params.callType === 'video' ? 'Incoming video call' : 'Incoming voice call';

  await Promise.all(
    uniqueIds.map((userId) =>
      params.notifications.create({
        organizationId: params.organizationId,
        recipientUserId: userId,
        actorUserId: params.actorUserId,
        type,
        title,
        message: `${callerName} is calling you`,
        entityType: 'call',
        entityId: params.callId,
        actionUrl: `/incoming-call/${params.callId}`,
        priority: 'high',
        category: 'call',
        dedupeKey: `direct-call:${params.callId}:${userId}`,
        metadata: {
          type,
          sound: 'incoming_call.wav',
          channelId: 'calls_ring_v1',
          callId: params.callId,
          callType: params.callType,
          callerName,
          conversationId: params.conversationId ?? null,
          category: 'call',
        },
      }).catch(() => 'duplicate' as const),
    ),
  );
}

export function createCallsRoutes(dependencies: CallsRouteDependencies) {
  const routes = new Hono();

  routes.get('/incoming', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const meetings = await dependencies.store.listIncomingRingingCalls(
      organizationId,
      auth.actor.userId,
    );
    return c.json({ calls: meetings.map(mapCall) });
  });

  routes.post('/', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    const callTypeRaw = String(body.callType ?? body.call_type ?? 'audio').toLowerCase();
    const callType = callTypeRaw === 'video' ? 'video' : 'audio';
    const participantIds = Array.isArray(body.participantIds ?? body.participant_ids)
      ? ((body.participantIds ?? body.participant_ids) as string[])
      : [];
    const conversationId =
      body.conversationId === undefined && body.conversation_id === undefined
        ? null
        : requireUuidValue(
            String(body.conversationId ?? body.conversation_id ?? ''),
            'conversationId',
          );

    const meeting = await dependencies.store.startDirectCall({
      organizationId,
      hostId: auth.actor.userId,
      participantIds,
      callType,
      conversationId,
      e2eePassphrase: generateE2eePassphrase(),
      title:
        typeof body.title === 'string'
          ? readRequiredText(body.title, 'title', 200)
          : null,
    });
    if (!meeting) throw new ValidationError('Call could not be created.');

    await notifyCallInvite({
      notifications: dependencies.notifications,
      organizationId,
      actorUserId: auth.actor.userId,
      actorEmail: auth.actor.email,
      userIds: participantIds,
      callId: meeting.id,
      callType,
      conversationId,
    });

    return c.json({ call: mapCall(meeting) }, 201);
  });

  routes.get('/:callId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const callId = requireUuidValue(c.req.param('callId'), 'callId');
    const meeting = await dependencies.store.getDirectCallMeeting(organizationId, callId);
    if (!meeting) throw new NotFoundError('CALL_NOT_FOUND', 'Call was not found.');
    await dependencies.store.assertDirectCallParticipant(callId, auth.actor.userId);
    return c.json({ call: mapCall(meeting) });
  });

  routes.get('/:callId/e2ee', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    const callId = requireUuidValue(c.req.param('callId'), 'callId');
    const passphrase = await dependencies.store.getE2eePassphrase(
      callId,
      auth.actor.userId,
    );
    if (!passphrase) {
      throw new NotFoundError('CALL_KEY_NOT_FOUND', 'Call encryption key was not found.');
    }
    return c.json({
      e2eePassphrase: passphrase,
      // Stable fingerprint for debugging only (not a secret).
      fingerprint: createHash('sha256').update(passphrase).digest('hex').slice(0, 12),
    });
  });

  routes.post('/:callId/accept', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const callId = requireUuidValue(c.req.param('callId'), 'callId');
    const meeting = await dependencies.store.acceptDirectCall({
      organizationId,
      meetingId: callId,
      userId: auth.actor.userId,
    });
    if (!meeting) throw new NotFoundError('CALL_NOT_FOUND', 'Call was not found.');
    return c.json({ call: mapCall(meeting) });
  });

  routes.post('/:callId/decline', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const callId = requireUuidValue(c.req.param('callId'), 'callId');
    const meeting = await dependencies.store.declineDirectCall({
      organizationId,
      meetingId: callId,
      userId: auth.actor.userId,
    });
    if (!meeting) throw new NotFoundError('CALL_NOT_FOUND', 'Call was not found.');
    return c.json({ call: mapCall(meeting) });
  });

  routes.post('/:callId/missed', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const callId = requireUuidValue(c.req.param('callId'), 'callId');
    await dependencies.store.assertDirectCallParticipant(callId, auth.actor.userId);
    const updated = await dependencies.store.markDirectCallMissed({
      organizationId,
      meetingId: callId,
    });
    return c.json({ ok: true, updated });
  });

  routes.post('/:callId/end', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const callId = requireUuidValue(c.req.param('callId'), 'callId');
    await dependencies.store.assertDirectCallParticipant(callId, auth.actor.userId);
    const meeting = await dependencies.store.endDirectCall({
      organizationId,
      meetingId: callId,
    });
    if (!meeting) throw new NotFoundError('CALL_NOT_FOUND', 'Call was not found.');
    return c.json({ call: mapCall(meeting) });
  });

  routes.post('/:callId/leave', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    const callId = requireUuidValue(c.req.param('callId'), 'callId');
    await dependencies.store.leaveDirectCall({
      meetingId: callId,
      userId: auth.actor.userId,
    });
    return c.json({ ok: true });
  });

  routes.post('/:callId/invite', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const callId = requireUuidValue(c.req.param('callId'), 'callId');
    const body = await readJson(c);
    const userIds = Array.isArray(body.userIds ?? body.user_ids)
      ? ((body.userIds ?? body.user_ids) as string[])
      : [];
    const meeting = await dependencies.store.getDirectCallMeeting(organizationId, callId);
    if (!meeting) throw new NotFoundError('CALL_NOT_FOUND', 'Call was not found.');
    if (meeting.host_id !== auth.actor.userId) {
      throw new ForbiddenError('CALL_HOST_REQUIRED', 'Only the caller can invite others.');
    }
    const callType = meeting.meeting_type === 'video' ? 'video' : 'audio';
    await dependencies.store.inviteDirectCallParticipants({
      organizationId,
      meetingId: callId,
      userIds,
      callType,
    });
    await notifyCallInvite({
      notifications: dependencies.notifications,
      organizationId,
      actorUserId: auth.actor.userId,
      actorEmail: auth.actor.email,
      userIds,
      callId,
      callType,
      conversationId: meeting.conversation_id,
    });
    return c.json({ ok: true });
  });

  routes.post('/:callId/livekit-token', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLivekitConfigured()) {
      throw new ValidationError(
        'LiveKit is not configured on Kode. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.',
      );
    }
    const callId = requireUuidValue(c.req.param('callId'), 'callId');
    const meeting = await dependencies.store.getDirectCallMeeting(organizationId, callId);
    if (!meeting) throw new NotFoundError('CALL_NOT_FOUND', 'Call was not found.');
    if (['ended', 'cancelled', 'missed', 'declined'].includes(meeting.status)) {
      throw new ValidationError('This call has already ended.');
    }
    const participant = await dependencies.store.assertDirectCallParticipant(
      callId,
      auth.actor.userId,
    );
    if (
      meeting.host_id !== auth.actor.userId &&
      (participant.invite_status ?? 'accepted') !== 'accepted'
    ) {
      throw new ForbiddenError('CALL_NOT_ACCEPTED', 'Accept the call before joining media.');
    }
    const roomName =
      meeting.livekit_room_name?.trim() || `call:${callId}`;
    const token = await mintLivekitToken({
      identity: auth.actor.userId,
      name: auth.actor.email || 'User',
      roomName,
      roomAdmin: meeting.host_id === auth.actor.userId,
    });
    return c.json(token);
  });

  return routes;
}
