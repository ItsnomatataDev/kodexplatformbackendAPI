import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../http/errors.js';
import { readJson, readRequiredText, requireUuidValue } from '../work/http.js';
import type { ContentStore } from '../content/store.js';
import { CONTENT_REVIEW_ASSETS_BUCKET } from '../content/buckets.js';
import type { FileStorage } from '../files/storage.js';
import type { MediaPlatformStore } from '../media-platform/store.js';
import type { MediaAsset, MediaJob, MediaVariant } from '../media-platform/types.js';
import { mediaGenerationPrefix } from '../media-platform/object-keys.js';
import { createMediaPlaybackUrl } from '../media-platform/playback/url.js';
import {
  MAX_MEDIA_IMAGE_BYTES,
  mediaImageObjectPath,
} from '../media-platform/playback/image-object.js';
import type { PlaybackGrantStore } from '../media-platform/playback/redis-grant.js';
import { MAX_MEDIA_SOURCE_BYTES } from '../media-platform/processing/source.js';

const PLAYBACK_TTL_SECONDS = 300;

export type MediaControlPlaneStore = Pick<
  MediaPlatformStore,
  | 'createAssetAndJob'
  | 'createReadyImageAsset'
  | 'getAssetForOrganization'
  | 'getJobsForAsset'
  | 'getVariantsByAssetId'
  | 'enqueueForOrganization'
>;
export type MediaPlatformDependencies = {
  store: MediaControlPlaneStore;
  content: Pick<ContentStore, 'findMediaOwnership'>;
  files: FileStorage;
  playbackSecret?: string;
  publicBaseUrl?: string;
  grants?: PlaybackGrantStore;
};
function authorize(auth: ReturnType<typeof getAuth>, action: 'read'|'manage') {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({context:auth,action:`content_studio.${action}`,resource:{type:'content_studio',organizationId}});
  return organizationId;
}
function isImageAsset(a: MediaAsset) {
  return a.mimeType.startsWith('image/');
}
function assetDto(a: MediaAsset) {
  const playbackReady = isImageAsset(a)
    ? a.playbackGeneration !== null
    : a.hlsGeneration !== null;
  return {id:a.id,originalFilename:a.originalFilename,mimeType:a.mimeType,sizeBytes:a.sizeBytes,
    status:a.status,playbackReady,createdAt:a.createdAt,updatedAt:a.updatedAt,
    errorCode:a.errorCode ? 'MEDIA_PROCESSING_FAILED' : null};
}
function variantDto(v: MediaVariant) {
  return {id:v.id,kind:v.kind,width:v.width,height:v.height,bitrateBps:v.bitrateBps,
    codec:v.codec,container:v.container,sizeBytes:v.sizeBytes,status:v.status};
}
function jobDto(j: MediaJob) {
  return {id:j.id,type:j.jobType,status:j.status,attempts:j.attempts,maxAttempts:j.maxAttempts,
    errorCode:j.errorCode ? 'MEDIA_PROCESSING_FAILED' : null};
}
function missing(): never { throw new NotFoundError('MEDIA_ASSET_NOT_FOUND','Media asset was not found.'); }
function publicOrigin(base: string | undefined): string {
  try {
    const url = new URL(base ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { throw new ServiceUnavailableError('MEDIA_PLAYBACK_UNAVAILABLE','Media playback is not configured.'); }
}
export function createMediaPlatformRoutes(deps: MediaPlatformDependencies) {
  const routes = new Hono();
  routes.use('*',async (c,next)=>{c.header('Cache-Control','no-store'); await next();});
  routes.post('/assets',async c => {
    const auth = getAuth(c);
    const org = authorize(auth,'manage');
    const body = await readJson(c);
    if (Object.keys(body).some(k=>k!=='sourceObjectKey')) throw new ValidationError('Only sourceObjectKey is accepted.');
    const key = readRequiredText(body.sourceObjectKey,'sourceObjectKey',1024);
    if (!(await deps.content.findMediaOwnership(org,key))) missing();
    if (!deps.files.headObject) throw new ServiceUnavailableError();
    const head = await deps.files.headObject(CONTENT_REVIEW_ASSETS_BUCKET,key);
    if (!head) missing();
    const imagePath = head.contentType ? mediaImageObjectPath(head.contentType) : null;
    if (imagePath) {
      if (head.sizeBytes === null || head.sizeBytes <= 0 || head.sizeBytes > MAX_MEDIA_IMAGE_BYTES) {
        throw new ValidationError('Source must be a nonempty image no larger than 20 MiB.');
      }
      const original = await deps.files.getObject(CONTENT_REVIEW_ASSETS_BUCKET, key);
      if (!original) missing();
      try {
        const asset = await deps.store.createReadyImageAsset({
          organizationId: org,
          uploadedBy: auth.actor.userId,
          originalFilename: key.split('/').pop() ?? 'image',
          mimeType: head.contentType!,
          sizeBytes: head.sizeBytes,
          originBucket: CONTENT_REVIEW_ASSETS_BUCKET,
          originObjectKey: key,
        });
        if (!asset.playbackGeneration) missing();
        await deps.files.putObject({
          bucket: CONTENT_REVIEW_ASSETS_BUCKET,
          objectKey: `${mediaGenerationPrefix(asset.id, asset.playbackGeneration)}/${imagePath}`,
          body: original.body,
          contentType: head.contentType,
        });
        return c.json({asset:assetDto(asset)},202);
      } catch(error) {
        if (error instanceof Error && error.message === 'media_source_conflict') missing();
        throw error;
      }
    }
    if (!head.contentType?.startsWith('video/') || head.sizeBytes === null || head.sizeBytes <= 0 || head.sizeBytes > MAX_MEDIA_SOURCE_BYTES) {
      throw new ValidationError('Source must be a nonempty video no larger than 2 GiB.');
    }
    try {
      const asset = await deps.store.createAssetAndJob({organizationId:org,uploadedBy:auth.actor.userId,
        originalFilename:key.split('/').pop() ?? 'video',mimeType:head.contentType,sizeBytes:head.sizeBytes,
        originBucket:CONTENT_REVIEW_ASSETS_BUCKET,originObjectKey:key});
      return c.json({asset:assetDto(asset)},202);
    } catch(error) {
      if (error instanceof Error && error.message === 'media_source_conflict') missing();
      throw error;
    }
  });
  routes.get('/assets/:assetId',async c=>{
    const org = authorize(getAuth(c),'read');
    const id = requireUuidValue(c.req.param('assetId'),'assetId');
    const asset = await deps.store.getAssetForOrganization(org,id);
    if (!asset) missing();
    const jobs = await deps.store.getJobsForAsset(org,id);
    return c.json({asset:assetDto(asset),jobs:jobs.map(jobDto)});
  });
  routes.get('/assets/:assetId/variants',async c=>{
    const org = authorize(getAuth(c),'read');
    const id = requireUuidValue(c.req.param('assetId'),'assetId');
    if (!(await deps.store.getAssetForOrganization(org,id))) missing();
    return c.json({variants:(await deps.store.getVariantsByAssetId(id)).map(variantDto)});
  });
  routes.post('/assets/:assetId/process',async c=>{
    const org = authorize(getAuth(c),'manage');
    const id = requireUuidValue(c.req.param('assetId'),'assetId');
    const job = await deps.store.enqueueForOrganization(org,id);
    if (!job) missing();
    return c.json({job:jobDto(job)},202);
  });
  routes.post('/assets/:assetId/playback',async c=>{
    const auth = getAuth(c);
    const org = authorize(auth,'read');
    const id = requireUuidValue(c.req.param('assetId'),'assetId');
    const asset = await deps.store.getAssetForOrganization(org,id);
    if (!asset) missing();
    const imagePath = mediaImageObjectPath(asset.mimeType);
    const generation = imagePath ? asset.playbackGeneration : asset.hlsGeneration;
    const objectPath = imagePath ?? undefined;
    if (!generation) throw new ConflictError('MEDIA_NOT_READY','Media playback is not ready.');
    if (!deps.playbackSecret || deps.playbackSecret.length < 32 || !deps.grants) {
      throw new ServiceUnavailableError('MEDIA_PLAYBACK_UNAVAILABLE');
    }
    const base = publicOrigin(deps.publicBaseUrl);
    const grant = createMediaPlaybackUrl({
      assetId: asset.id,
      generation,
      secret: deps.playbackSecret,
      ttlSeconds: PLAYBACK_TTL_SECONDS,
      ...(objectPath ? { objectPath } : {}),
    });
    await deps.grants.issue(
      {
        signature: grant.signature,
        assetId: asset.id,
        generation,
        organizationId: org,
        userId: auth.actor.userId,
        expiresAt: grant.expiresAt,
      },
      PLAYBACK_TTL_SECONDS * 1000,
    );
    return c.json({assetId:asset.id,playbackUrl:base+grant.path,expiresAt:grant.expiresAt});
  });
  return routes;
}
