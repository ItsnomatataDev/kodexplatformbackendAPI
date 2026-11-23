const IMAGE_FTYP_BRANDS = new Set([
  'avif',
  'avis',
  'heic',
  'heix',
  'heif',
  'mif1',
  'msf1',
]);

function readU32(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function fourcc(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length) return '';
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function findFtypBrand(prefix: Uint8Array): string | null {
  let offset = 0;
  while (offset + 8 <= prefix.length) {
    let size = readU32(prefix, offset);
    const type = fourcc(prefix, offset + 4);
    if (size === 1) {
      if (offset + 16 > prefix.length) break;
      const high = readU32(prefix, offset + 8);
      const low = readU32(prefix, offset + 12);
      if (high !== 0 || low < 16) break;
      size = low;
    } else if (size === 0) {
      size = prefix.length - offset;
    }
    if (type === 'ftyp') {
      const brandOffset = size === 1 || readU32(prefix, offset) === 1 ? offset + 16 : offset + 8;
      const brand = fourcc(prefix, brandOffset);
      return brand || null;
    }
    if (size < 8) break;
    offset += size;
  }

  for (let index = 0; index + 8 <= prefix.length; index += 1) {
    if (fourcc(prefix, index) === 'ftyp') {
      return fourcc(prefix, index + 4) || null;
    }
  }
  return null;
}

function isIsoBaseMediaVideo(prefix: Uint8Array) {
  const brand = findFtypBrand(prefix);
  return Boolean(brand) && !IMAGE_FTYP_BRANDS.has(brand!);
}

export function mediaPrefixMatches(mimeType: string, prefix: Uint8Array) {
  const ascii = String.fromCharCode(...prefix.subarray(0, Math.min(prefix.length, 512)));
  const starts = (...bytes: number[]) =>
    bytes.every((byte, index) => prefix[index] === byte);

  switch (mimeType) {
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/gif':
      return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
    case 'image/webp':
      return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    case 'image/avif':
      return ascii.slice(4, 8) === 'ftyp' && /^(avif|avis)$/.test(ascii.slice(8, 12));
    case 'image/svg+xml': {
      const normalized = ascii.replace(/^\uFEFF/, '').trimStart();
      return (
        /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(normalized) &&
        !/<!DOCTYPE|<!ENTITY/i.test(normalized)
      );
    }
    case 'video/mp4':
    case 'video/quicktime':
      return isIsoBaseMediaVideo(prefix);
    case 'video/webm':
    case 'video/x-matroska':
      return starts(0x1a, 0x45, 0xdf, 0xa3);
    case 'video/x-msvideo':
      return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ';
    default:
      return false;
  }
}
