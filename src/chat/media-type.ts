const INLINE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function startsWith(prefix: Uint8Array, bytes: number[]) {
  return bytes.every((byte, index) => prefix[index] === byte);
}

export function isInlineChatImageType(contentType: string) {
  return INLINE_IMAGE_TYPES.has(contentType.toLowerCase());
}

export function chatImageMatchesContentType(
  contentType: string,
  bytes: Uint8Array,
) {
  const mime = contentType.toLowerCase();
  const ascii = String.fromCharCode(
    ...bytes.subarray(0, Math.min(bytes.length, 16)),
  );
  switch (mime) {
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/gif':
      return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
    case 'image/webp':
      return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    default:
      return false;
  }
}
