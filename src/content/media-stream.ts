import { resolvePlaybackObject } from './playback.js';
import type { FileStorage } from '../files/storage.js';
import { NotFoundError } from '../http/errors.js';


export async function streamStoredMedia(params: {
  files: FileStorage;
  bucket: string;
  objectKey: string;
  rangeHeader?: string | null;
  cacheControl?: string;
  preferPlayback?: boolean;
  contentType?: string | null;
  contentDisposition?: string;
  notFoundCode?: string;
  notFoundMessage?: string;
}) {
  const cacheControl = params.cacheControl ?? 'private, max-age=300';
  const disposition = params.contentDisposition ?? 'inline';
  const notFoundCode = params.notFoundCode ?? 'CONTENT_MEDIA_NOT_FOUND';
  const notFoundMessage = params.notFoundMessage ?? 'Media not found.';
  const contentTypeFor = (stored: string | null | undefined) =>
    playbackContentType(params.contentType ?? stored, params.objectKey);

  if (params.files.getObjectStream) {
    const objectKey = params.preferPlayback
      ? await resolvePlaybackObject(params.files, params.bucket, params.objectKey)
      : params.objectKey;
    const streamed = await params.files.getObjectStream(
      params.bucket,
      objectKey,
      params.rangeHeader,
    );
    if (!streamed) {
      throw new NotFoundError(notFoundCode, notFoundMessage);
    }

    const headers: Record<string, string> = {
      'Content-Type': objectKey !== params.objectKey ? 'video/mp4' : contentTypeFor(streamed.contentType),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition,
      'Cache-Control': cacheControl,
    };
    if (streamed.contentLength != null) {
      headers['Content-Length'] = String(streamed.contentLength);
    }
    if (streamed.contentRange) {
      headers['Content-Range'] = streamed.contentRange;
    }

    return new Response(streamed.status === 416 ? null : streamed.body, {
      status: streamed.status,
      headers,
    });
  }

  throw new NotFoundError(
    'OBJECT_STORAGE_STREAM_UNAVAILABLE',
    'Streaming media storage is unavailable.',
  );
}

export function attachmentDisposition(
  kind: 'inline' | 'attachment',
  filename: string,
) {
  const safe = filename.replace(/[\r\n"]/g, '_').slice(0, 180) || 'file';
  return `${kind}; filename="${safe}"`;
}

const PLAYBACK_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** Preserve an explicit stored MIME type; infer only when storage omitted it. */
function playbackContentType(stored: string | null | undefined, objectKey: string) {
  const type = stored?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream') {
    return type;
  }
  const ext = objectKey.split('.').pop()?.toLowerCase() ?? '';
  return PLAYBACK_TYPES[ext] ?? (type || 'application/octet-stream');
}

function parseBytesRange(header: string | null | undefined, size: number) {
  if (!header?.trim() || size <= 0) return null;
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;

  let start = match[1] === '' ? NaN : Number(match[1]);
  let end = match[2] === '' ? NaN : Number(match[2]);

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    // suffix: bytes=-N
    const suffix = end;
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return null;
  }
  if (start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}
