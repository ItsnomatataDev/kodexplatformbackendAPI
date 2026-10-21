export type StoredObject = {
  bucket: string;
  objectKey: string;
  contentType: string | null;
  sizeBytes: number;
  checksum: string | null;
  body: Buffer;
};

export type ObjectHead = {
  bucket: string;
  objectKey: string;
  contentType: string | null;
  sizeBytes: number | null;
};

/** Streaming download (supports HTTP Range for video seeking). */
export type ObjectStreamResult = {
  bucket: string;
  objectKey: string;
  contentType: string | null;
  /** Total object size when known. */
  sizeBytes: number | null;
  /** Length of this response body. */
  contentLength: number | null;
  contentRange: string | null;
  status: 200 | 206 | 416;
  body: ReadableStream<Uint8Array>;
};

export type PutObjectInput = {
  bucket: string;
  objectKey: string;
  body: Buffer;
  contentType?: string | null;
};

/** Stream a body to object storage without Base64 or re-encoding. */
export type PutObjectStreamInput = {
  bucket: string;
  objectKey: string;
  body: ReadableStream<Uint8Array> | Buffer;
  contentType?: string | null;
  contentLength: number;
};

export type MultipartPart = {
  partNumber: number;
  sizeBytes: number;
  etag: string;
};

export interface MultipartFileStorage {
  initiateMultipartUpload(
    bucket: string,
    objectKey: string,
    contentType: string,
  ): Promise<string>;
  putMultipartPartStream(input: {
    bucket: string;
    objectKey: string;
    uploadId: string;
    partNumber: number;
    body: ReadableStream<Uint8Array>;
    contentLength: number;
  }): Promise<{ etag: string }>;
  listMultipartParts(
    bucket: string,
    objectKey: string,
    uploadId: string,
  ): Promise<MultipartPart[]>;
  completeMultipartUpload(
    bucket: string,
    objectKey: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<void>;
  abortMultipartUpload(
    bucket: string,
    objectKey: string,
    uploadId: string,
  ): Promise<void>;
  findMultipartUpload?(bucket: string, objectKey: string): Promise<string | null>;
}

export interface FileStorage {
  putObject(input: PutObjectInput): Promise<void>;
  putObjectStream?(input: PutObjectStreamInput): Promise<void>;
  getObject(bucket: string, objectKey: string): Promise<StoredObject | null>;
  headObject?(bucket: string, objectKey: string): Promise<ObjectHead | null>;
  getObjectStream?(
    bucket: string,
    objectKey: string,
    rangeHeader?: string | null,
  ): Promise<ObjectStreamResult | null>;
  deleteObject(bucket: string, objectKey: string): Promise<void>;
  ensureBucket?(bucket: string): Promise<void>;
}
