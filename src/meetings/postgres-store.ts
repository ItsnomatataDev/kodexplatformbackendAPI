import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

const LEGACY = 'Direct call started from mobile chat';

function mapMeeting(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    host_id: row.host_id as string,
    status: row.status as string,
    meeting_type: row.meeting_type as string,
    room_code: row.room_code as string,
    livekit_room_name: (row.livekit_room_name as string | null) ?? null,
    meet_url: (row.meet_url as string | null) ?? null,
    allow_guest_access: Boolean(row.allow_guest_access),
    guest_code: (row.guest_code as string | null) ?? null,
    scheduled_start: row.scheduled_start ? (row.scheduled_start as Date).toISOString() : null,
    scheduled_for: row.scheduled_for ? (row.scheduled_for as Date).toISOString() : null,
    started_at: row.started_at ? (row.started_at as Date).toISOString() : null,
    ended_at: row.ended_at ? (row.ended_at as Date).toISOString() : null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
    participant_count: Number(row.participant_count ?? 0),
  };
}

function roomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function guestCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const token = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12).toUpperCase();
  return `G-${token}`;
}

export class PostgresMeetingsStore {
  async listMeetings(organizationId: string) {
    const lookback = new Date(Date.now() - 14 * 86400000).toISOString();
    const [active, ended] = await Promise.all([
      db.query(
        `SELECT m.*,
                (SELECT count(*) FROM meetings.participants p WHERE p.meeting_id = m.id) AS participant_count
         FROM meetings.meetings m
         WHERE m.organization_id = $1
           AND m.status IN ('live', 'scheduled')
           AND (m.description IS NULL OR m.description <> $2)
         ORDER BY m.created_at DESC
         LIMIT 40`,
        [organizationId, LEGACY],
      ),
      db.query(
        `SELECT m.*, 0 AS participant_count
         FROM meetings.meetings m
         WHERE m.organization_id = $1
           AND m.status IN ('ended', 'cancelled')
           AND m.created_at >= $2::timestamptz
           AND (m.description IS NULL OR m.description <> $3)
         ORDER BY m.created_at DESC
         LIMIT 15`,
        [organizationId, lookback, LEGACY],
      ),
    ]);
    return [...active.rows, ...ended.rows].map(mapMeeting);
  }

  async listCalendar(organizationId: string, rangeStart: string, rangeEnd: string) {
    const result = await db.query(
      `SELECT id, title, status, scheduled_start, scheduled_for, started_at
       FROM meetings.meetings
       WHERE organization_id = $1
         AND (description IS NULL OR description <> $4)
         AND (
           status = 'live'
           OR (
             status = 'scheduled'
             AND scheduled_start >= $2::timestamptz
             AND scheduled_start <= $3::timestamptz
           )
         )
       ORDER BY scheduled_start ASC NULLS LAST
       LIMIT 80`,
      [organizationId, rangeStart, rangeEnd, LEGACY],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      scheduled_start: row.scheduled_start ? (row.scheduled_start as Date).toISOString() : null,
      scheduled_for: row.scheduled_for ? (row.scheduled_for as Date).toISOString() : null,
      started_at: row.started_at ? (row.started_at as Date).toISOString() : null,
    }));
  }

  async getMeeting(organizationId: string, meetingId: string) {
    const result = await db.query(
      `SELECT * FROM meetings.meetings WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [organizationId, meetingId],
    );
    if (!result.rows[0]) return null;
    const meeting = mapMeeting(result.rows[0]);
    const participants = await db.query(
      `SELECT p.*,
              pr.full_name, pr.avatar_url, u.email
       FROM meetings.participants p
       LEFT JOIN identity.user_profiles pr ON pr.user_id = p.user_id
       LEFT JOIN identity.users u ON u.id = p.user_id
       WHERE p.meeting_id = $1
       ORDER BY p.joined_at NULLS LAST, p.created_at ASC`,
      [meetingId],
    );
    return {
      ...meeting,
      participants: participants.rows.map((row) => ({
        id: row.id,
        meeting_id: row.meeting_id,
        user_id: row.user_id,
        role: row.role,
        joined_at: row.joined_at ? (row.joined_at as Date).toISOString() : null,
        left_at: row.left_at ? (row.left_at as Date).toISOString() : null,
        is_muted: Boolean(row.is_muted),
        is_camera_on: Boolean(row.is_camera_on),
        profile: {
          id: row.user_id,
          full_name: row.full_name ?? null,
          email: row.email ?? null,
          avatar_url: row.avatar_url ?? null,
        },
      })),
    };
  }

  async createMeeting(input: {
    organizationId: string;
    title: string;
    description?: string | null;
    hostId: string;
    meetingType: 'audio' | 'video';
    scheduledStart?: string | null;
    allowGuestAccess?: boolean;
    participantIds?: string[];
    meetUrlBuilder: (id: string) => string;
  }) {
    const isScheduled = Boolean(input.scheduledStart);
    const code = roomCode();
    const inserted = await db.query(
      `INSERT INTO meetings.meetings (
         organization_id, title, description, host_id, meeting_type,
         scheduled_start, status, started_at, room_code, allow_guest_access, guest_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        input.organizationId,
        input.title,
        input.description ?? null,
        input.hostId,
        input.meetingType,
        input.scheduledStart ?? new Date().toISOString(),
        isScheduled ? 'scheduled' : 'live',
        isScheduled ? null : new Date().toISOString(),
        code,
        Boolean(input.allowGuestAccess),
        input.allowGuestAccess ? guestCode() : null,
      ],
    );
    const meeting = inserted.rows[0];
    const livekitRoom = `meeting:${meeting.id}`;
    const meetUrl = input.meetUrlBuilder(String(meeting.id));
    await db.query(
      `UPDATE meetings.meetings
       SET livekit_room_name = $2, meet_url = $3, scheduled_for = COALESCE($4, scheduled_start), updated_at = NOW()
       WHERE id = $1`,
      [meeting.id, livekitRoom, meetUrl, input.scheduledStart ?? null],
    );
    const participantIds = new Set([input.hostId, ...(input.participantIds ?? [])]);
    for (const userId of participantIds) {
      await db.query(
        `INSERT INTO meetings.participants (
           meeting_id, user_id, role, joined_at, is_muted, is_camera_on
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (meeting_id, user_id) DO NOTHING`,
        [
          meeting.id,
          userId,
          userId === input.hostId ? 'host' : 'participant',
          isScheduled ? null : new Date().toISOString(),
          true,
          input.meetingType === 'video',
        ],
      );
    }
    return this.getMeeting(input.organizationId, String(meeting.id));
  }

  async updateMeetingStatus(
    organizationId: string,
    meetingId: string,
    status: 'live' | 'ended' | 'cancelled' | 'scheduled',
  ) {
    const patch: Record<string, unknown> = { status };
    if (status === 'live') patch.started_at = new Date().toISOString();
    if (status === 'ended' || status === 'cancelled') patch.ended_at = new Date().toISOString();
    const result = await db.query(
      `UPDATE meetings.meetings
       SET status = $3,
           started_at = COALESCE($4::timestamptz, started_at),
           ended_at = COALESCE($5::timestamptz, ended_at),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING id`,
      [
        organizationId,
        meetingId,
        status,
        patch.started_at ?? null,
        patch.ended_at ?? null,
      ],
    );
    if (!result.rows[0]) throw new NotFoundError('MEETING_NOT_FOUND', 'Meeting not found.');
    return this.getMeeting(organizationId, meetingId);
  }

  async joinMeeting(organizationId: string, meetingId: string, userId: string) {
    const meeting = await this.getMeeting(organizationId, meetingId);
    if (!meeting) throw new NotFoundError('MEETING_NOT_FOUND', 'Meeting not found.');
    await db.query(
      `INSERT INTO meetings.participants (meeting_id, user_id, role, joined_at, left_at, is_muted, is_camera_on)
       VALUES ($1,$2,'participant',NOW(),NULL,TRUE,$3)
       ON CONFLICT (meeting_id, user_id) DO UPDATE
       SET joined_at = COALESCE(meetings.participants.joined_at, NOW()), left_at = NULL`,
      [meetingId, userId, meeting.meeting_type === 'video'],
    );
    return this.getMeeting(organizationId, meetingId);
  }

  async listMessages(meetingId: string) {
    const result = await db.query(
      `SELECT m.*, p.full_name, p.avatar_url, u.email
       FROM meetings.messages m
       LEFT JOIN identity.user_profiles p ON p.user_id = m.sender_id
       LEFT JOIN identity.users u ON u.id = m.sender_id
       WHERE m.meeting_id = $1
       ORDER BY m.created_at ASC`,
      [meetingId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      meeting_id: row.meeting_id,
      sender_id: row.sender_id,
      body: row.body,
      created_at: (row.created_at as Date).toISOString(),
      sender: {
        id: row.sender_id,
        full_name: row.full_name ?? null,
        email: row.email ?? null,
        avatar_url: row.avatar_url ?? null,
      },
    }));
  }

  async createMessage(meetingId: string, senderId: string, body: string) {
    if (!body.trim()) throw new ValidationError('Message body is required.');
    const result = await db.query(
      `INSERT INTO meetings.messages (meeting_id, sender_id, body)
       VALUES ($1,$2,$3) RETURNING id`,
      [meetingId, senderId, body.trim()],
    );
    const messages = await this.listMessages(meetingId);
    return messages.find((m) => m.id === result.rows[0].id) ?? messages[messages.length - 1];
  }

  async getMeetingById(meetingId: string) {
    const result = await db.query(`SELECT * FROM meetings.meetings WHERE id = $1 LIMIT 1`, [meetingId]);
    return result.rows[0] ? mapMeeting(result.rows[0]) : null;
  }

  async getParticipant(meetingId: string, userId: string) {
    const result = await db.query(
      `SELECT * FROM meetings.participants WHERE meeting_id = $1 AND user_id = $2 LIMIT 1`,
      [meetingId, userId],
    );
    return result.rows[0] ?? null;
  }

  async getGuestMeeting(guestCode: string) {
    const result = await db.query(
      `SELECT * FROM meetings.meetings
       WHERE guest_code = $1 AND allow_guest_access = TRUE
       LIMIT 1`,
      [guestCode],
    );
    return result.rows[0] ? mapMeeting(result.rows[0]) : null;
  }

  async createGuest(input: {
    meetingId: string;
    name: string;
    email?: string | null;
    isCameraOn: boolean;
  }) {
    const result = await db.query(
      `INSERT INTO meetings.guests (
         meeting_id, name, email, joined_at, left_at, is_muted, is_camera_on, last_seen_at
       ) VALUES ($1,$2,$3,NOW(),NULL,TRUE,$4,NOW())
       RETURNING id, meeting_id, name, email, joined_at, left_at, is_muted, is_camera_on, last_seen_at, created_at`,
      [input.meetingId, input.name, input.email ?? null, input.isCameraOn],
    );
    return mapGuest(result.rows[0]);
  }

  async leaveGuest(meetingId: string, guestId: string) {
    await db.query(
      `UPDATE meetings.guests
       SET left_at = NOW()
       WHERE id = $1 AND meeting_id = $2 AND left_at IS NULL`,
      [guestId, meetingId],
    );
  }

  async listActiveGuests(meetingId: string) {
    const result = await db.query(
      `SELECT id, meeting_id, name, email, joined_at, left_at, is_muted, is_camera_on, last_seen_at, created_at
       FROM meetings.guests
       WHERE meeting_id = $1 AND left_at IS NULL
       ORDER BY joined_at ASC NULLS LAST, created_at ASC`,
      [meetingId],
    );
    return result.rows.map(mapGuest);
  }

  async getActiveGuest(meetingId: string, guestId: string) {
    const result = await db.query(
      `SELECT id FROM meetings.guests
       WHERE id = $1 AND meeting_id = $2 AND left_at IS NULL
       LIMIT 1`,
      [guestId, meetingId],
    );
    return result.rows[0] ?? null;
  }

  async createSignal(input: {
    meetingId: string;
    senderId: string;
    receiverId: string;
    signalType: string;
    payload?: unknown;
  }) {
    const result = await db.query(
      `INSERT INTO meetings.signals (
         meeting_id, sender_id, receiver_id, signal_type, payload
       ) VALUES ($1,$2,$3,$4,$5::jsonb)
       RETURNING id, meeting_id, sender_id, receiver_id, signal_type, payload, created_at`,
      [
        input.meetingId,
        input.senderId,
        input.receiverId,
        input.signalType,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return mapSignal(result.rows[0]);
  }

  async listSignalsForReceiver(params: {
    meetingId: string;
    receiverId: string;
    since?: string | null;
  }) {
    const result = await db.query(
      `SELECT id, meeting_id, sender_id, receiver_id, signal_type, payload, created_at
       FROM meetings.signals
       WHERE meeting_id = $1
         AND receiver_id = $2
         AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz)
       ORDER BY created_at ASC
       LIMIT 100`,
      [params.meetingId, params.receiverId, params.since ?? null],
    );
    return result.rows.map(mapSignal);
  }

  async deleteSignal(signalId: string, userId: string) {
    await db.query(
      `DELETE FROM meetings.signals
       WHERE id = $1 AND (sender_id = $2 OR receiver_id = $2)`,
      [signalId, userId],
    );
  }

  async recordModeration(input: {
    meetingId: string;
    hostId: string;
    action: 'mute' | 'camera_off' | 'remove';
    targetUserId?: string;
    targetGuestId?: string;
    reason?: string;
  }) {
    const leftAt = new Date().toISOString();
    if (input.targetGuestId) {
      if (input.action === 'remove') {
        await db.query(
          `UPDATE meetings.guests
           SET left_at = $3::timestamptz, is_muted = TRUE, is_camera_on = FALSE
           WHERE meeting_id = $1 AND id = $2`,
          [input.meetingId, input.targetGuestId, leftAt],
        );
      } else if (input.action === 'mute') {
        await db.query(
          `UPDATE meetings.guests SET is_muted = TRUE
           WHERE meeting_id = $1 AND id = $2 AND left_at IS NULL`,
          [input.meetingId, input.targetGuestId],
        );
      } else {
        await db.query(
          `UPDATE meetings.guests SET is_camera_on = FALSE
           WHERE meeting_id = $1 AND id = $2 AND left_at IS NULL`,
          [input.meetingId, input.targetGuestId],
        );
      }
      return {
        ok: true as const,
        action: input.action,
        targetIdentity: `guest:${input.targetGuestId}`,
        signal: null,
      };
    }

    const targetUserId = input.targetUserId!;
    if (input.action === 'remove') {
      await db.query(
        `UPDATE meetings.participants
         SET left_at = $3::timestamptz, is_muted = TRUE, is_camera_on = FALSE
         WHERE meeting_id = $1 AND user_id = $2`,
        [input.meetingId, targetUserId, leftAt],
      );
    } else if (input.action === 'mute') {
      await db.query(
        `UPDATE meetings.participants SET is_muted = TRUE
         WHERE meeting_id = $1 AND user_id = $2`,
        [input.meetingId, targetUserId],
      );
    } else {
      await db.query(
        `UPDATE meetings.participants SET is_camera_on = FALSE
         WHERE meeting_id = $1 AND user_id = $2`,
        [input.meetingId, targetUserId],
      );
    }

    const signalType =
      input.action === 'mute'
        ? 'force_mute'
        : input.action === 'camera_off'
          ? 'force_camera_off'
          : 'remove_participant';
    const reason =
      input.reason ??
      (input.action === 'mute'
        ? 'Host has muted you'
        : input.action === 'camera_off'
          ? 'Host has turned off your camera'
          : 'Removed by host');

    const signal = await this.createSignal({
      meetingId: input.meetingId,
      senderId: input.hostId,
      receiverId: targetUserId,
      signalType,
      payload: {
        reason,
        requestedBy: input.hostId,
        timestamp: new Date().toISOString(),
      },
    });

    return {
      ok: true as const,
      action: input.action,
      targetIdentity: targetUserId,
      signal,
    };
  }

  async heartbeatPresence(meetingId: string, userId: string) {
    const result = await db.query(
      `UPDATE meetings.participants
       SET last_seen_at = NOW()
       WHERE meeting_id = $1 AND user_id = $2
       RETURNING id, meeting_id, user_id, last_seen_at`,
      [meetingId, userId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('PARTICIPANT_NOT_FOUND', 'You are not a participant in this meeting.');
    }
    return {
      meeting_id: result.rows[0].meeting_id as string,
      user_id: result.rows[0].user_id as string,
      last_seen_at: (result.rows[0].last_seen_at as Date).toISOString(),
    };
  }

  async listPresence(meetingId: string) {
    const [participants, guests] = await Promise.all([
      db.query(
        `SELECT user_id, last_seen_at, left_at, is_muted, is_camera_on
         FROM meetings.participants
         WHERE meeting_id = $1`,
        [meetingId],
      ),
      db.query(
        `SELECT id AS guest_id, last_seen_at, left_at, is_muted, is_camera_on
         FROM meetings.guests
         WHERE meeting_id = $1 AND left_at IS NULL`,
        [meetingId],
      ),
    ]);
    return {
      participants: participants.rows.map((row) => ({
        user_id: row.user_id as string,
        last_seen_at: row.last_seen_at
          ? (row.last_seen_at as Date).toISOString()
          : null,
        left_at: row.left_at ? (row.left_at as Date).toISOString() : null,
        is_muted: Boolean(row.is_muted),
        is_camera_on: Boolean(row.is_camera_on),
        online: Boolean(
          row.last_seen_at &&
            !row.left_at &&
            Date.now() - (row.last_seen_at as Date).getTime() < 45_000,
        ),
      })),
      guests: guests.rows.map((row) => ({
        guest_id: row.guest_id as string,
        last_seen_at: row.last_seen_at
          ? (row.last_seen_at as Date).toISOString()
          : null,
        left_at: row.left_at ? (row.left_at as Date).toISOString() : null,
        is_muted: Boolean(row.is_muted),
        is_camera_on: Boolean(row.is_camera_on),
        online: Boolean(
          row.last_seen_at &&
            Date.now() - (row.last_seen_at as Date).getTime() < 45_000,
        ),
      })),
    };
  }

  async markMeetingLiveIfScheduled(meetingId: string) {
    await db.query(
      `UPDATE meetings.meetings
       SET status = 'live',
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND status = 'scheduled'`,
      [meetingId],
    );
  }
}

function mapGuest(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    meeting_id: row.meeting_id as string,
    name: row.name as string,
    email: (row.email as string | null) ?? null,
    joined_at: row.joined_at ? (row.joined_at as Date).toISOString() : null,
    left_at: row.left_at ? (row.left_at as Date).toISOString() : null,
    is_muted: Boolean(row.is_muted),
    is_camera_on: Boolean(row.is_camera_on),
    last_seen_at: row.last_seen_at
      ? (row.last_seen_at as Date).toISOString()
      : null,
    created_at: row.created_at
      ? (row.created_at as Date).toISOString()
      : null,
  };
}

function mapSignal(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    meeting_id: row.meeting_id as string,
    sender_id: (row.sender_id as string | null) ?? null,
    receiver_id: (row.receiver_id as string | null) ?? null,
    signal_type: row.signal_type as string,
    payload: row.payload ?? {},
    created_at: (row.created_at as Date).toISOString(),
  };
}
