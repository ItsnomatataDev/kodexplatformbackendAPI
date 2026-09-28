import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import os from 'node:os';
import { env } from '../config/env.js';
import { MinioFileStorage } from '../files/minio-storage.js';

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
  source?: string;
};

export type PlatformStorageSnapshot = {
  databaseBytes: number | null;
  storageBytes: number | null;
  appUsedBytes: number | null;
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
    backupsBytes: number | null;
    dockerBytes: number | null;
    containerdBytes: number | null;
    logsBytes: number | null;
    osBytes: number | null;
    otherBytes: number | null;
  };
  history: Array<{
    checkedAt: string;
    diskUsedBytes: number;
    diskTotalBytes: number;
    ramUsedBytes: number;
    ramTotalBytes: number;
  }>;
};

export type ProbeStatus = 'healthy' | 'degraded' | 'down';

export type LivekitProbe = {
  url: string;
  status: ProbeStatus;
  latencyMs: number | null;
  httpStatus: number | null;
};

export type ObjectStorageProbe = {
  endpoint: string;
  status: ProbeStatus;
  latencyMs: number | null;
  httpStatus: number | null;
};

export function classifyProbe(ok: boolean, latencyMs: number | null, degradedAt = 800): ProbeStatus {
  if (!ok) return 'down';
  if (typeof latencyMs === 'number' && latencyMs >= degradedAt) return 'degraded';
  return 'healthy';
}

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

export function parseLinuxMemory(text: string): HostRamUsage | null {
  const values = new Map([...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
  const totalBytes = values.get('MemTotal');
  const availableBytes = values.get('MemAvailable');
  if (!totalBytes || availableBytes == null || availableBytes > totalBytes) return null;
  const usedBytes = totalBytes - availableBytes;
  return { totalBytes, availableBytes, usedBytes, percent: percent(usedBytes, totalBytes) ?? 0, source: 'linux-memavailable' };
}

export function readHostRamUsage(): HostRamUsage {
  if (process.platform === 'linux') {
    try {
      const linux = parseLinuxMemory(readFileSync('/proc/meminfo', 'utf8'));
      if (linux) return linux;
    } catch { /* Non-Linux or restricted proc mount. */ }
  }
  const totalBytes = os.totalmem();
  const availableBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return { usedBytes, totalBytes, availableBytes, percent: percent(usedBytes, totalBytes) ?? 0, source: 'os-free-memory' };
}

export function runtimeDiagnostics() {
  const memory = process.memoryUsage();
  const readCgroup = (path: string) => {
    try { const value = Number(readFileSync(path, 'utf8').trim()); return Number.isFinite(value) ? value : null; }
    catch { return null; }
  };
  return {
    processRssBytes: memory.rss, processHeapUsedBytes: memory.heapUsed,
    processExternalBytes: memory.external, processUptimeSeconds: Math.round(process.uptime()),
    loadAverage: os.loadavg(), logicalCpuCount: os.cpus().length,
    containerMemoryUsedBytes: readCgroup('/sys/fs/cgroup/memory.current'),
    containerMemoryLimitBytes: readCgroup('/sys/fs/cgroup/memory.max'),
    diskPath: process.env.HOST_DISK_PATH || '/',
  };
}

async function readDiskFromDf(): Promise<HostDiskUsage | null> {
  try {
    // `-k -P` works on both Linux and macOS (1K-blocks, POSIX output).
    const { stdout } = await execFileAsync('df', ['-k', '-P', process.env.HOST_DISK_PATH || '/'], {
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

export async function probeObjectStorage(): Promise<ObjectStorageProbe> {
  const endpoint = env.minio.endpoint;
  const start = Date.now();
  if (!env.minio.accessKey || !env.minio.secretKey) {
    return { endpoint, status: 'down', latencyMs: 0, httpStatus: null };
  }

  try {
    const storage = new MinioFileStorage();
    const httpStatus = await storage.headBucket(env.minio.bucket);
    const latencyMs = Date.now() - start;
    const reachable = httpStatus != null && httpStatus < 500;
    return {
      endpoint,
      status: classifyProbe(reachable, latencyMs),
      latencyMs,
      httpStatus,
    };
  } catch {
    return {
      endpoint,
      status: 'down',
      latencyMs: Date.now() - start,
      httpStatus: null,
    };
  }
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
  databaseBytes: number | null;
  storageBytes: number | null;
  disk: HostDiskUsage;
  ram: HostRamUsage;
}): PlatformStorageSnapshot {
  const checkedAt = new Date().toISOString();
  const diskUsed = input.disk.usedBytes;
  const diskTotal = input.disk.totalBytes;
  const appUsedBytes = input.databaseBytes != null && input.storageBytes != null
    ? input.databaseBytes + input.storageBytes : null;

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
      backupsBytes: null,
      dockerBytes: null,
      containerdBytes: null,
      logsBytes: null,
      osBytes: null,
      otherBytes: null,
    },
    // No persisted host samples are collected by this API.
    history: [],
  };
}
