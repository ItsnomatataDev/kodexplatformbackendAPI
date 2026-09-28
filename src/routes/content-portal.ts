import { Hono } from 'hono';
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../http/errors.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import type { FileStorage } from '../files/storage.js';
import type { ContentStore } from '../content/store.js';
import {
  CONTENT_REVIEW_ASSETS_BUCKET,
} from '../content/buckets.js';
import { streamStoredMedia } from '../content/media-stream.js';
import {
  hashClientPin,
  hashClientSession,
} from '../content/pin.js';
import {
  parseDisplaySlot,
  portalCanReview,
  portalFeedbackState,
} from '../content/portal.js';
import { FIELD_LIMITS } from '../http/limits.js';

export type ContentPortalRouteDependencies = {
  store: ContentStore;
  files: FileStorage;
};

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function serializePortalClient(client: {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  portalToken: string;
}) {
  return {
    id: client.id,
    company_name: client.companyName,
    contact_name: client.contactName,
    email: client.email,
    portal_token: client.portalToken,
  };
}

async function requirePortalClient(
  store: ContentStore,
  clientToken: string,
  email: string,
  sessionToken?: string | null,
) {
  const client = await store.getClientByPortalToken(clientToken, email);
  if (!client) {
    return { error: 'unauthorized' as const, client: null };
  }
  if (sessionToken != null) {
    const expected = hashClientSession({
      portalToken: client.portalToken,
      email: client.email,
      loginPinHash: client.loginPinHash,
    });
    if (sessionToken !== expected) {
      return { error: 'unauthorized' as const, client: null };
    }
  }
  return { error: null, client };
}

export function createContentPortalRoutes(
  dependencies: ContentPortalRouteDependencies,
) {
  const routes = new Hono();

  routes.post('/login', async (c) => {
    const body = await readJson(c);
    const clientToken = readRequiredText(body.clientToken ?? body.client_token, 'clientToken', 120);
    const email = readRequiredText(body.email ?? body.login_email, 'email', 320).toLowerCase();
    const pin = readRequiredText(body.pin ?? body.raw_pin, 'pin', 32);

    const client = await dependencies.store.getClientByPortalToken(clientToken, email);
    if (!client) {
      return c.json({ ok: false, error: 'invalid_login' });
    }
    if (client.pinExpiresAt && client.pinExpiresAt.getTime() < Date.now()) {
      return c.json({ ok: false, error: 'pin_expired' });
    }
    if (client.loginPinHash !== hashClientPin(client.portalToken, pin)) {
      return c.json({ ok: false, error: 'invalid_login' });
    }

    const sessionToken = hashClientSession({
      portalToken: client.portalToken,
      email: client.email,
      loginPinHash: client.loginPinHash,
    });

    return c.json({
      ok: true,
      session_token: sessionToken,
      client: serializePortalClient(client),
    });
  });

  routes.post('/session', async (c) => {
    const body = await readJson(c);
    const clientToken = readRequiredText(body.clientToken ?? body.client_token, 'clientToken', 120);
    const email = readRequiredText(body.email ?? body.login_email, 'email', 320).toLowerCase();
    const sessionToken = readRequiredText(
      body.sessionToken ?? body.session_token,
      'sessionToken',
      128,
    );

    const auth = await requirePortalClient(
      dependencies.store,
      clientToken,
      email,
      sessionToken,
    );
    if (!auth.client) {
      return c.json({ ok: false, error: auth.error ?? 'unauthorized' });
    }

    const schedules = await dependencies.store.listSchedulesForClient(auth.client.id);
    const assets = await dependencies.store.listAssetsForSchedules(
      auth.client.organizationId,
      schedules.map((row) => row.id),
    );
    const assetsBySchedule = new Map<string, typeof assets>();
    for (const asset of assets) {
      const list = assetsBySchedule.get(asset.scheduleId) ?? [];
      list.push(asset);
      assetsBySchedule.set(asset.scheduleId, list);
    }

    const drafts = schedules.map((schedule) => {
      const scheduleAssets = (assetsBySchedule.get(schedule.id) ?? []).filter(
        (asset) => asset.isSelected !== false,
      );
      const thumb = scheduleAssets[0];
      return {
        id: schedule.id,
        title: schedule.title,
        summary: schedule.summary,
        status: schedule.status,
        scheduled_at: iso(schedule.scheduledAt),
        last_viewed_at: iso(schedule.lastViewedAt),
        approved_at: iso(schedule.approvedAt),
        thumbnail_url: thumb?.fileUrl ?? null,
        can_review: portalCanReview(schedule),
      };
    });

    return c.json({
      ok: true,
      client: serializePortalClient(auth.client),
      drafts,
    });
  });

  routes.post('/reviews/:scheduleId', async (c) => {
    const body = await readJson(c);
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const clientToken = readRequiredText(body.clientToken ?? body.client_token, 'clientToken', 120);
    const email = readRequiredText(body.email ?? body.login_email, 'email', 320).toLowerCase();
    const sessionToken = readRequiredText(
      body.sessionToken ?? body.session_token,
      'sessionToken',
      128,
    );

    const auth = await requirePortalClient(
      dependencies.store,
      clientToken,
      email,
      sessionToken,
    );
    if (!auth.client) {
      return c.json({ ok: false, error: 'unauthorized' });
    }

    const schedule = await dependencies.store.getScheduleForClient(
      auth.client.id,
      scheduleId,
    );
    if (!schedule) {
      return c.json({ ok: false, error: 'not_found' });
    }
    if (schedule.status === 'draft' || schedule.status === 'archived') {
      return c.json({ ok: false, error: 'not_available' });
    }
    if (!portalCanReview(schedule)) {
      return c.json({ ok: false, error: 'not_released' });
    }

    if (schedule.status === 'sent_to_client') {
      await dependencies.store.updateSchedule(
        auth.client.organizationId,
        schedule.id,
        { status: 'viewed', lastViewedAt: new Date() },
      );
    } else {
      await dependencies.store.updateSchedule(
        auth.client.organizationId,
        schedule.id,
        { lastViewedAt: new Date() },
      );
    }

    const refreshed =
      (await dependencies.store.getScheduleForClient(auth.client.id, scheduleId)) ??
      schedule;

    const [assets, comments] = await Promise.all([
      dependencies.store.listAssetsForSchedules(auth.client.organizationId, [
        scheduleId,
      ]),
      dependencies.store.listComments(auth.client.organizationId, [scheduleId]),
    ]);

    const selectedAssets = assets.filter((asset) => asset.isSelected !== false);
    const clientComments = comments.filter(
      (comment) =>
        comment.visibility === 'client_visible' &&
        comment.authorType === 'client' &&
        (comment.authorEmail ?? '').toLowerCase() === auth.client!.email.toLowerCase(),
    );

    return c.json({
      ok: true,
      client: serializePortalClient(auth.client),
      draft: {
        id: refreshed.id,
        title: refreshed.title,
        subtitle: refreshed.subtitle,
        body: refreshed.body,
        summary: refreshed.summary,
        captions: refreshed.captions,
        notes: refreshed.notes,
        layout_type: refreshed.layoutType,
        status: refreshed.status,
        scheduled_at: iso(refreshed.scheduledAt),
        approved_at: iso(refreshed.approvedAt),
        approved_by_name: refreshed.approvedByName,
        approved_by_email: refreshed.approvedByEmail,
        changes_requested_at: iso(refreshed.changesRequestedAt),
        last_viewed_at: iso(refreshed.lastViewedAt),
        client_id: refreshed.clientId,
        created_at: iso(refreshed.createdAt),
        updated_at: iso(refreshed.updatedAt),
      },
      assets: selectedAssets.map((asset) => ({
        id: asset.id,
        draft_id: asset.scheduleId,
        file_name: asset.fileName,
        file_url: asset.fileUrl,
        storage_path: asset.storagePath,
        mime_type: asset.mimeType,
        asset_type: asset.assetType,
        heading: asset.heading,
        caption: asset.caption,
        is_selected: asset.isSelected,
        display_slot: asset.displaySlot,
        sort_order: asset.sortOrder,
        crop_x: asset.cropX,
        crop_y: asset.cropY,
        crop_zoom: asset.cropZoom,
        compression_status: asset.compressionStatus,
        web_playback_status: asset.webPlaybackStatus,
        created_at: iso(asset.createdAt),
      })),
      comments: clientComments.map((comment) => ({
        id: comment.id,
        draft_id: comment.scheduleId,
        author_name: comment.authorName,
        author_email: comment.authorEmail,
        body: comment.body,
        comment: comment.body,
        source: comment.source,
        visibility: comment.visibility,
        author_type: comment.authorType,
        comment_type: comment.commentType,
        display_slot: comment.displaySlot,
        created_at: iso(comment.createdAt),
      })),
      feedback: portalFeedbackState({
        assets: selectedAssets,
        comments,
        clientEmail: auth.client.email,
      }),
    });
  });

  routes.post('/reviews/:scheduleId/feedback', async (c) => {
    const body = await readJson(c);
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const clientToken = readRequiredText(body.clientToken ?? body.client_token, 'clientToken', 120);
    const email = readRequiredText(body.email ?? body.login_email, 'email', 320).toLowerCase();
    const sessionToken = readRequiredText(
      body.sessionToken ?? body.session_token,
      'sessionToken',
      128,
    );
    const decision = readRequiredText(body.decision, 'decision', 40);
    const feedbackBody = readRequiredText(
      body.comment ?? body.feedback_body,
      'comment',
      FIELD_LIMITS.commentBody,
    );

    const auth = await requirePortalClient(
      dependencies.store,
      clientToken,
      email,
      sessionToken,
    );
    if (!auth.client) {
      return c.json({ ok: false, error: 'unauthorized' });
    }

    const client = auth.client;
    return dependencies.store.withReviewTransaction(client.organizationId, scheduleId, async (store) => {
      const schedule = await store.getScheduleForClient(
        client.id,
        scheduleId,
      );
      if (!schedule) return c.json({ ok: false, error: 'not_found' });
      if (
        schedule.status === 'draft' ||
        schedule.status === 'archived' ||
        schedule.status === 'ready_for_review'
      ) {
        return c.json({ ok: false, error: 'not_available' });
      }
      if (!portalCanReview(schedule)) {
        return c.json({ ok: false, error: 'not_released' });
      }
      if (schedule.status === 'published') {
        return c.json({ ok: false, error: 'read_only' });
      }

      const [assets, comments] = await Promise.all([
        store.listAssetsForSchedules(client.organizationId, [
          scheduleId,
        ]),
        store.listComments(client.organizationId, [scheduleId]),
      ]);
      const selectedAssets = assets.filter((asset) => asset.isSelected !== false);
      const parsedSlot = parseDisplaySlot(feedbackBody);
      const currentFeedback = portalFeedbackState({ assets: selectedAssets, comments, clientEmail: client.email });
      if (parsedSlot != null && !selectedAssets.some((asset) => (asset.displaySlot ?? asset.sortOrder) === parsedSlot)) {
        return c.json({ ok: false, error: 'invalid_slot' });
      }

      let nextStatus = schedule.status;
      let activity = 'client_commented';
      let commentType = 'client_comment';

      if (decision === 'approved') {
        if (parsedSlot != null) {
          const already = currentFeedback.approved_slots.includes(parsedSlot);
          if (already) {
            return c.json({ ok: false, error: 'already_approved' });
          }
        }
        activity = 'client_approved';
        commentType = 'approval_note';
      } else if (decision === 'changes_requested') {
        nextStatus = 'changes_requested';
        activity = 'client_requested_changes';
        commentType = 'change_request';
      } else if (decision === 'revoke_approval') {
        if (schedule.status !== 'approved') {
          return c.json({ ok: false, error: 'not_approved' });
        }
        nextStatus = schedule.lastViewedAt ? 'viewed' : 'sent_to_client';
        activity = 'client_revoked_approval';
        commentType = 'change_request';
      } else if (decision !== 'comment') {
        return c.json({ ok: false, error: 'invalid_decision' });
      }

      const insertedComment = await store.addComment({
        scheduleId,
        organizationId: client.organizationId,
        officeId: client.officeId,
        authorName: client.contactName || client.companyName,
        authorEmail: client.email,
        body: feedbackBody,
        createdBy: null,
        displaySlot: parsedSlot,
        source: 'client_portal',
        visibility: 'client_visible',
        authorType: 'client',
        commentType,
      });

      const patch: {
        status?: typeof nextStatus;
        changesRequestedAt?: Date | null;
        approvedAt?: Date | null;
        approvedByName?: string | null;
        approvedByEmail?: string | null;
      } = {};

      if (decision === 'changes_requested') {
        patch.status = 'changes_requested';
        patch.changesRequestedAt = new Date();
        patch.approvedAt = null;
        patch.approvedByName = null;
        patch.approvedByEmail = null;
      } else if (decision === 'revoke_approval') {
        patch.status = nextStatus;
        patch.approvedAt = null;
        patch.approvedByName = null;
        patch.approvedByEmail = null;
      } else if (decision === 'approved') {
        const nextComments = [...comments, insertedComment];
        const feedback = portalFeedbackState({
          assets: selectedAssets,
          comments: nextComments,
          clientEmail: client.email,
        });
        if (feedback.all_posts_approved) {
          patch.status = 'approved';
          patch.changesRequestedAt = null;
          patch.approvedAt = new Date();
          patch.approvedByName = client.contactName || client.companyName;
          patch.approvedByEmail = client.email;
        }
      }

      if (Object.keys(patch).length > 0) {
        await store.updateSchedule(
          client.organizationId,
          scheduleId,
          patch,
        );
      }

      await store.recordActivity({
        scheduleId,
        organizationId: client.organizationId,
        officeId: client.officeId,
        actorUserId: null,
        activityType: activity,
        metadata: { decision, displaySlot: parsedSlot },
      });

      const [updatedSchedule, updatedComments] = await Promise.all([
        store.getScheduleForClient(client.id, scheduleId),
        store.listComments(client.organizationId, [scheduleId]),
      ]);

      return c.json({
        ok: true,
        status: updatedSchedule?.status ?? nextStatus,
        feedback: portalFeedbackState({
          assets: selectedAssets,
          comments: updatedComments,
          clientEmail: client.email,
        }),
      });
    });
  });


  routes.get('/media', async (c) => {
    const clientToken = c.req.query('clientToken') ?? c.req.query('client_token');
    const email = c.req.query('email') ?? c.req.query('login_email');
    const sessionToken = c.req.query('sessionToken') ?? c.req.query('session_token');
    const objectKey = c.req.query('objectKey') ?? c.req.query('object_key');
    if (!clientToken || !email || !sessionToken || !objectKey) {
      throw new ValidationError('Missing portal media parameters.');
    }

    const auth = await requirePortalClient(
      dependencies.store,
      clientToken,
      email,
      sessionToken,
    );
    if (!auth.client) {
      throw new UnauthorizedError('PORTAL_UNAUTHORIZED', 'Portal session is invalid.');
    }

    if (!objectKey.startsWith(`${auth.client.organizationId}/`)) {
      throw new NotFoundError('CONTENT_MEDIA_NOT_FOUND', 'Media was not found.');
    }

    return streamStoredMedia({
      files: dependencies.files,
      bucket: CONTENT_REVIEW_ASSETS_BUCKET,
      objectKey,
      rangeHeader: c.req.header('range'),
      cacheControl: 'private, max-age=300',
    });
  });

  return routes;
}
