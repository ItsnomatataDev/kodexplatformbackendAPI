import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { readJson, readRequiredText, requireUuidValue } from '../work/http.js';
import { mintLivekitToken, isLivekitConfigured } from '../meetings/livekit.js';
import { requireProductOrg } from '../products/staff.js';
import type { PostgresMeetingsStore } from '../meetings/postgres-store.js';

export type MeetingsRouteDependencies = { store: PostgresMeetingsStore };

const MODERATION_ACTIONS = new Set(['mute', 'camera_off', 'remove']);

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

export function createMeetingsRoutes(dependencies: MeetingsRouteDependencies) {
  const routes = new Hono();

  routes.get('/', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({ meetings: await dependencies.store.listMeetings(organizationId) });
  });

  routes.get('/calendar', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const rangeStart = c.req.query('rangeStart');
    const rangeEnd = c.req.query('rangeEnd');
    if (!rangeStart || !rangeEnd) throw new ValidationError('rangeStart and rangeEnd are required.');
    return c.json({
      events: await dependencies.store.listCalendar(organizationId, rangeStart, rangeEnd),
    });
  });

  routes.get('/:meetingId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const meeting = await dependencies.store.getMeeting(organizationId, meetingId);
    if (!meeting) throw new NotFoundError('MEETING_NOT_FOUND', 'Meeting not found.');
    return c.json({ meeting });
  });

  routes.post('/', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    const meeting = await dependencies.store.createMeeting({
      organizationId,
      title: readRequiredText(body.title, 'title', 200),
      description: (body.description ?? null) as string | null,
      hostId: auth.actor.userId,
      meetingType: (body.meeting_type ?? body.meetingType ?? 'video') as 'audio' | 'video',
      scheduledStart: (body.scheduled_start ?? body.scheduledStart ?? null) as string | null,
      allowGuestAccess: Boolean(body.allow_guest_access ?? body.allowGuestAccess),
      participantIds: Array.isArray(body.participant_ids ?? body.participantIds)
        ? ((body.participant_ids ?? body.participantIds) as string[])
        : [],
      meetUrlBuilder: (id) => `/meetings/${id}`,
    });
    return c.json({ meeting }, 201);
  });

  routes.post('/:meetingId/join', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const meeting = await dependencies.store.joinMeeting(organizationId, meetingId, auth.actor.userId);
    return c.json({ meeting });
  });

  routes.post('/:meetingId/status', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const body = await readJson(c);
    const status = String(body.status ?? '');
    if (!['live', 'ended', 'cancelled', 'scheduled'].includes(status)) {
      throw new ValidationError('Invalid meeting status.');
    }
    const meeting = await dependencies.store.updateMeetingStatus(
      organizationId,
      meetingId,
      status as 'live' | 'ended' | 'cancelled' | 'scheduled',
    );
    return c.json({ meeting });
  });

  routes.get('/:meetingId/messages', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    return c.json({ messages: await dependencies.store.listMessages(meetingId) });
  });

  routes.post('/:meetingId/messages', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const body = await readJson(c);
    const message = await dependencies.store.createMessage(
      meetingId,
      auth.actor.userId,
      readRequiredText(body.body, 'body', 4000),
    );
    return c.json({ message }, 201);
  });

  routes.post('/:meetingId/livekit-token', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLivekitConfigured()) {
      throw new ValidationError('LiveKit is not configured on Kode. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.');
    }
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const meeting = await dependencies.store.getMeeting(organizationId, meetingId);
    if (!meeting) throw new NotFoundError('MEETING_NOT_FOUND', 'Meeting not found.');
    if (meeting.status === 'ended' || meeting.status === 'cancelled') {
      throw new ValidationError('This meeting has already ended.');
    }
    const participant = await dependencies.store.getParticipant(meetingId, auth.actor.userId);
    if (!participant && meeting.host_id !== auth.actor.userId) {
      throw new ForbiddenError('NOT_PARTICIPANT', 'You are not a participant in this meeting.');
    }
    const roomName = (meeting.livekit_room_name as string | null)?.trim() || `meeting:${meetingId}`;
    const name = auth.actor.email || 'User';
    const token = await mintLivekitToken({
      identity: auth.actor.userId,
      name,
      roomName,
      roomAdmin: meeting.host_id === auth.actor.userId,
    });
    return c.json(token);
  });

  routes.get('/:meetingId/guests', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const meeting = await dependencies.store.getMeeting(organizationId, meetingId);
    if (!meeting) throw new NotFoundError('MEETING_NOT_FOUND', 'Meeting not found.');
    return c.json({ guests: await dependencies.store.listActiveGuests(meetingId) });
  });

  routes.get('/:meetingId/signals', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const since = c.req.query('since') || null;
    return c.json({
      signals: await dependencies.store.listSignalsForReceiver({
        meetingId,
        receiverId: auth.actor.userId,
        since,
      }),
    });
  });

  routes.post('/:meetingId/signals', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const body = await readJson(c);
    const receiverId = requireUuidValue(
      String(body.receiver_id ?? body.receiverId ?? ''),
      'receiverId',
    );
    const signalType = readRequiredText(
      body.signal_type ?? body.signalType,
      'signalType',
      80,
    );
    const signal = await dependencies.store.createSignal({
      meetingId,
      senderId: auth.actor.userId,
      receiverId,
      signalType,
      payload: body.payload ?? {},
    });
    return c.json({ signal }, 201);
  });

  routes.delete('/:meetingId/signals/:signalId', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const signalId = requireUuidValue(c.req.param('signalId'), 'signalId');
    await dependencies.store.deleteSignal(signalId, auth.actor.userId);
    return c.json({ ok: true });
  });

  routes.post('/:meetingId/moderate', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const body = await readJson(c);
    const action = String(body.action ?? '');
    if (!MODERATION_ACTIONS.has(action)) {
      throw new ValidationError('Unsupported moderation action.');
    }
    const targetUserId = body.target_user_id ?? body.targetUserId;
    const targetGuestId = body.target_guest_id ?? body.targetGuestId;
    if (!targetUserId && !targetGuestId) {
      throw new ValidationError('Provide targetUserId or targetGuestId.');
    }
    if (targetUserId && targetGuestId) {
      throw new ValidationError('Provide only one of targetUserId or targetGuestId.');
    }
    if (targetUserId && String(targetUserId) === auth.actor.userId) {
      throw new ValidationError('You cannot moderate yourself.');
    }

    const meeting = await dependencies.store.getMeeting(organizationId, meetingId);
    if (!meeting) throw new NotFoundError('MEETING_NOT_FOUND', 'Meeting not found.');
    if (meeting.host_id !== auth.actor.userId) {
      throw new ForbiddenError('NOT_HOST', 'Only the meeting host can moderate participants.');
    }
    if (meeting.status === 'ended' || meeting.status === 'cancelled') {
      throw new ValidationError('This meeting has already ended.');
    }

    if (targetGuestId) {
      const guest = await dependencies.store.getActiveGuest(
        meetingId,
        requireUuidValue(String(targetGuestId), 'targetGuestId'),
      );
      if (!guest) {
        throw new NotFoundError('GUEST_NOT_FOUND', 'Guest is not active in this meeting.');
      }
    }

    const result = await dependencies.store.recordModeration({
      meetingId,
      hostId: auth.actor.userId,
      action: action as 'mute' | 'camera_off' | 'remove',
      targetUserId: targetUserId
        ? requireUuidValue(String(targetUserId), 'targetUserId')
        : undefined,
      targetGuestId: targetGuestId
        ? requireUuidValue(String(targetGuestId), 'targetGuestId')
        : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });

    return c.json(result);
  });

  routes.post('/:meetingId/presence', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    const presence = await dependencies.store.heartbeatPresence(
      meetingId,
      auth.actor.userId,
    );
    return c.json({ presence });
  });

  routes.get('/:meetingId/presence', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    const meetingId = requireUuidValue(c.req.param('meetingId'), 'meetingId');
    return c.json({ presence: await dependencies.store.listPresence(meetingId) });
  });

  return routes;
}

/** Unauthenticated guest join/leave — mounted outside Bearer middleware. */
export function createPublicMeetingGuestRoutes(
  dependencies: MeetingsRouteDependencies,
) {
  const routes = new Hono();

  routes.post('/token', async (c) => {
    if (!isLivekitConfigured()) {
      throw new ValidationError(
        'LiveKit is not configured on Kode. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.',
      );
    }

    const body = await readJson(c);
    const action = String(body.action ?? 'join');

    if (action === 'leave') {
      const meetingId = requireUuidValue(
        String(body.meeting_id ?? body.meetingId ?? ''),
        'meetingId',
      );
      const guestId = requireUuidValue(
        String(body.guest_id ?? body.guestId ?? ''),
        'guestId',
      );
      await dependencies.store.leaveGuest(meetingId, guestId);
      return c.json({ ok: true });
    }

    const meetingCode = readRequiredText(
      body.meeting_code ?? body.meetingCode,
      'meetingCode',
      64,
    );
    const name = readRequiredText(body.name, 'name', 120);
    const emailRaw = body.email;
    const email =
      typeof emailRaw === 'string' && emailRaw.trim()
        ? emailRaw.trim().slice(0, 254)
        : null;

    const meeting = await dependencies.store.getGuestMeeting(meetingCode);
    if (!meeting) {
      throw new NotFoundError('MEETING_NOT_FOUND', 'Meeting link is invalid.');
    }
    if (meeting.status === 'ended' || meeting.status === 'cancelled') {
      throw new ValidationError('This meeting has already ended.');
    }
    if (!meeting.allow_guest_access || !meeting.guest_code) {
      throw new ForbiddenError(
        'GUEST_ACCESS_DISABLED',
        'Guest access is not enabled for this meeting.',
      );
    }
    if (
      meeting.status === 'scheduled' &&
      meeting.scheduled_start &&
      new Date(meeting.scheduled_start).getTime() > Date.now()
    ) {
      throw new ForbiddenError(
        'MEETING_NOT_STARTED',
        'This meeting has not started yet.',
      );
    }

    if (meeting.status === 'scheduled') {
      await dependencies.store.markMeetingLiveIfScheduled(meeting.id);
    }

    const guest = await dependencies.store.createGuest({
      meetingId: meeting.id,
      name,
      email,
      isCameraOn: meeting.meeting_type === 'video',
    });

    const roomName =
      (meeting.livekit_room_name as string | null)?.trim() ||
      `meeting:${meeting.id}`;
    const identity = `guest:${guest.id}`;
    const token = await mintLivekitToken({
      identity,
      name,
      roomName,
      roomAdmin: false,
      canPublishData: false,
    });

    return c.json({
      ...token,
      guestId: guest.id,
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      meetingType: meeting.meeting_type,
    });
  });

  routes.post('/leave', async (c) => {
    const body = await readJson(c);
    const meetingId = requireUuidValue(
      String(body.meeting_id ?? body.meetingId ?? ''),
      'meetingId',
    );
    const guestId = requireUuidValue(
      String(body.guest_id ?? body.guestId ?? ''),
      'guestId',
    );
    await dependencies.store.leaveGuest(meetingId, guestId);
    return c.json({ ok: true });
  });

  return routes;
}
