export type ObjectReference = {
  bucket: string;
  objectKey: string;
  contentType?: string;
  sizeBytes?: number;
  checksum?: string;
  originalFilename?: string;
};

export function objectReferenceToUri(reference: ObjectReference): string {
  return `s3://${reference.bucket}/${reference.objectKey}`;
}
