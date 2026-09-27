import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import os from 'node:os';
import { env } from '../config/env.js';

const execFileAsync = promisify(execFile);

export type HostDiskUsage = {
  usedBytes: number | null;
  totalBytes: number | null;
  source: 'df' | 'env' | 'unavailable';
};

export type HostRamUsage = {
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  percent: number;
};

export type PlatformStorageSnapshot = {
  databaseBytes: number;
  storageBytes: number;
  appUsedBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskPercent: number | null;
  diskCheckedAt: string | null;
  hostname: string | null;
  provider: 'hetzner';
  ramUsedBytes: number | null;
  ramTotalBytes: number | null;
  ramAvailableBytes: number | null;
  ramPercent: number | null;
  diskBreakdown: {
    backupsBytes: number;
    dockerBytes: number;
    containerdBytes: number;
    logsBytes: number;
    osBytes: number;
    otherBytes: number;
  };
  history: Array<{
    checkedAt: string;
    diskUsedBytes: number;
    diskTotalBytes: number;
    ramUsedBytes: number;
    ramTotalBytes: number;
  }>;
};

export type LivekitProbe = {
  url: string;
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number | null;
  httpStatus: number | null;
};

function envBytes(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function percent(used: number | null, total: number | null): number | null {
  if (used == null || total == null || total <= 0) return null;
  return Math.round((used / total) * 1000) / 10;
}

export function readHostRamUsage(): HostRamUsage {
  const totalBytes = os.totalmem();
  const availableBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    usedBytes,
    totalBytes,
    availableBytes,
    percent: percent(usedBytes, totalBytes) ?? 0,
  };
}

async function readDiskFromDf(): Promise<HostDiskUsage | null> {
  try {
    // `-k -P` works on both Linux and macOS (1K-blocks, POSIX output).
    const { stdout } = await execFileAsync('df', ['-k', '-P', '/'], {
      timeout: 2500,
      maxBuffer: 64 * 1024,
    });
    const line = stdout.trim().split('\n')[1] ?? '';
    const parts = line.split(/\s+/);
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    if (!Number.isFinite(totalKb) || totalKb <= 0) return null;
    return {
      usedBytes: Number.isFinite(usedKb) ? usedKb * 1024 : null,
      totalBytes: totalKb * 1024,
      source: 'df',
    };
  } catch {
    return null;
  }
}

export async function readHostDiskUsage(): Promise<HostDiskUsage> {
  const fromDf = await readDiskFromDf();
  if (fromDf?.totalBytes) return fromDf;

  const envUsed = envBytes('HOST_DISK_USED_BYTES');
  const envTotal = envBytes('HOST_DISK_TOTAL_BYTES');
  if (envTotal) {
    return {
      usedBytes: envUsed,
      totalBytes: envTotal,
      source: 'env',
    };
  }

  return { usedBytes: null, totalBytes: null, source: 'unavailable' };
}

export async function probeLivekit(): Promise<LivekitProbe> {
  const raw = (env.livekit.url || 'wss://meet.itsnomatata.com').trim();
  const httpUrl = raw
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://');
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(httpUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const ok =
      response.ok || [401, 403, 404, 405, 426].includes(response.status);
    return {
      url: raw,
      status: ok ? (latencyMs >= 800 ? 'degraded' : 'healthy') : 'down',
      latencyMs,
      httpStatus: response.status,
    };
  } catch {
    return {
      url: raw,
      status: 'down',
      latencyMs: Date.now() - start,
      httpStatus: null,
    };
  }
}

export function buildStorageSnapshot(input: {
  databaseBytes: number;
  storageBytes: number;
  disk: HostDiskUsage;
  ram: HostRamUsage;
}): PlatformStorageSnapshot {
  const checkedAt = new Date().toISOString();
  const diskUsed = input.disk.usedBytes;
  const diskTotal = input.disk.totalBytes;
  const appUsedBytes = input.databaseBytes + input.storageBytes;
  const known = appUsedBytes;
  const otherBytes =
    diskUsed != null && diskUsed > known ? Math.max(0, diskUsed - known) : 0;

  return {
    databaseBytes: input.databaseBytes,
    storageBytes: input.storageBytes,
    appUsedBytes,
    diskUsedBytes: diskUsed,
    diskTotalBytes: diskTotal,
    diskPercent: percent(diskUsed, diskTotal),
    diskCheckedAt: diskTotal ? checkedAt : null,
    hostname: hostname() || null,
    provider: 'hetzner',
    ramUsedBytes: input.ram.usedBytes,
    ramTotalBytes: input.ram.totalBytes,
    ramAvailableBytes: input.ram.availableBytes,
    ramPercent: input.ram.percent,
    diskBreakdown: {
      backupsBytes: 0,
      dockerBytes: 0,
      containerdBytes: 0,
      logsBytes: 0,
      osBytes: 0,
      otherBytes,
    },
    history: diskUsed != null && diskTotal != null
      ? [
          {
            checkedAt,
            diskUsedBytes: diskUsed,
            diskTotalBytes: diskTotal,
            ramUsedBytes: input.ram.usedBytes,
            ramTotalBytes: input.ram.totalBytes,
          },
        ]
      : [],
  };
}
