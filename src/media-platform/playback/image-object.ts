export const MAX_MEDIA_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_PATHS: Record<string, string> = {
  'image/jpeg': 'image/original.jpg',
  'image/jpg': 'image/original.jpg',
  'image/png': 'image/original.png',
  'image/webp': 'image/original.webp',
  'image/gif': 'image/original.gif',
};

export function mediaImageObjectPath(mimeType: string): string | null {
  return IMAGE_PATHS[mimeType.toLowerCase()] ?? null;
}
