export type StoredObject = {
  bucket: string;
  objectKey: string;
  contentType: string | null;
  sizeBytes: number;
  checksum: string | null;
  body: Buffer;
};

export type PutObjectInput = {
  bucket: string;
  objectKey: string;
  body: Buffer;
  contentType?: string | null;
};

export interface FileStorage {
  putObject(input: PutObjectInput): Promise<void>;
  getObject(bucket: string, objectKey: string): Promise<StoredObject | null>;
  deleteObject(bucket: string, objectKey: string): Promise<void>;
}
