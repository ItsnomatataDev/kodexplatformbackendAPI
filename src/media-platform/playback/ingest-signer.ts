export const MEDIA_INGEST_URL_TTL_SECONDS = 300;

export type MediaIngestSignInput = {
  bucket: string;
  objectKey: string;
  uploadId: string;
  partNumber: number;
};

export type MediaIngestSigner = {
  sign(input: MediaIngestSignInput): Promise<string>;
};

type PresignedPutClient = {
  presignedUrl(
    method: string,
    bucketName: string,
    objectName: string,
    expires?: number,
    reqParams?: Record<string, string>,
  ): Promise<string>;
};

export function createMediaIngestSigner(options: {
  client: PresignedPutClient;
  ttlSeconds?: number;
}): MediaIngestSigner {
  const ttlSeconds = options.ttlSeconds ?? MEDIA_INGEST_URL_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 300) {
    throw new Error('Invalid media ingest URL TTL');
  }

  return {
    async sign(input) {
      if (
        !Number.isInteger(input.partNumber) ||
        input.partNumber < 1 ||
        input.partNumber > 10_000
      ) {
        throw new Error('Invalid ingest part number');
      }
      return options.client.presignedUrl(
        'PUT',
        input.bucket,
        input.objectKey,
        ttlSeconds,
        {
          uploadId: input.uploadId,
          partNumber: String(input.partNumber),
        },
      );
    },
  };
}
