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
