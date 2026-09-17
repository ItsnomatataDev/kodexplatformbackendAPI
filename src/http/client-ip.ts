import net from 'node:net';

export function normalizeIp(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  let ip = value.trim();
  if (ip.length === 0) {
    return null;
  }

  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  } else if (net.isIPv4(ip.split(':')[0] ?? '') && ip.includes(':')) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }

  if (ip.toLowerCase().startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  if (net.isIP(ip) === 0) {
    return null;
  }

  return ip;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((part) => Number(part));
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const network = normalizeIp(base);

  if (!network || !net.isIPv4(network) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }

  const mask = bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask);
}

export function parseTrustedProxyIps(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isTrustedProxyAddress(
  ip: string,
  trustedProxyIps: readonly string[],
): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return false;
  }

  for (const entry of trustedProxyIps) {
    if (entry.includes('/')) {
      if (net.isIPv4(normalized) && ipv4InCidr(normalized, entry)) {
        return true;
      }
      continue;
    }

    if (normalizeIp(entry) === normalized) {
      return true;
    }
  }

  return false;
}

export function parseForwardedAddresses(header: string | null | undefined): string[] {
  if (!header) {
    return [];
  }

  return header
    .split(',')
    .map((part) => normalizeIp(part))
    .filter((ip): ip is string => ip != null);
}

export function resolveClientIp(input: {
  remoteAddress: string | null | undefined;
  forwardedFor?: string | null;
  realIp?: string | null;
  trustedProxyIps: readonly string[];
}): string | null {
  const remote = normalizeIp(input.remoteAddress);

  if (!remote || !isTrustedProxyAddress(remote, input.trustedProxyIps)) {
    return remote;
  }

  const forwarded = parseForwardedAddresses(input.forwardedFor);
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const hop = forwarded[index];
    if (!isTrustedProxyAddress(hop, input.trustedProxyIps)) {
      return hop;
    }
  }

  if (forwarded.length > 0) {
    return forwarded[0];
  }

  return normalizeIp(input.realIp) ?? remote;
}
