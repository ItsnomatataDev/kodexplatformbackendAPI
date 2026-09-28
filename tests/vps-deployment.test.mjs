import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateVps } from '../scripts/deploy/validate-vps.mjs';
import { verifyHttp } from '../scripts/deploy/verify-vps.mjs';

const valid = () => ({ services: {
  api: { network_mode: 'host', environment: { HOST: '0.0.0.0', PORT: '3000', APP_ENV: 'staging', NODE_ENV: 'staging' } },
  postgres: { ports: [{ host_ip: '127.0.0.1', target: 5432 }] },
  redis: { ports: [{ host_ip: '127.0.0.1', target: 6379 }] },
  minio: { ports: [{ host_ip: '127.0.0.1', target: 9000 }, { host_ip: '127.0.0.1', target: 9001 }] },
} });

test('VPS validator rejects loopback regression, topology drift and public data stores', () => {
  assert.match(validateVps(valid()), /valid/);
  for (const change of [
    (c) => { c.services.api.environment.HOST = '127.0.0.1'; },
    (c) => { c.services.api.environment.PORT = '3001'; },
    (c) => { c.services.api.network_mode = 'bridge'; },
    (c) => { c.services.api.environment.APP_ENV = 'production'; },
    (c) => { c.services.postgres.ports[0].host_ip = '0.0.0.0'; },
    (c) => { c.services.api.ports = [{ target: 3000 }]; },
  ]) {
    const config = valid();
    change(config);
    assert.throws(() => validateVps(config));
  }
});

test('authoritative VPS file renders fixed HOST despite conflicting env_file and shell values', (t) => {
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('Docker Compose unavailable; run npm run validate:vps where installed');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'kode-vps-config-'));
  try {
    const source = readFileSync(new URL('../docker-compose.vps.yml', import.meta.url), 'utf8');
    writeFileSync(join(dir, 'docker-compose.vps.yml'), source);
    // Synthetic credentials only. Never read the developer or VPS secret file.
    writeFileSync(join(dir, '.env.vps'), 'HOST=127.0.0.1\nPORT=9999\nDATABASE_PASSWORD=test\nREDIS_PASSWORD=test\nMINIO_ACCESS_KEY=test\nMINIO_SECRET_KEY=test\n');
    const render = () => JSON.parse(execFileSync('docker', ['compose', '--env-file', '.env.vps', '-f', 'docker-compose.vps.yml', 'config', '--format', 'json'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, HOST: '127.0.0.1', PORT: '9999' }, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    assert.doesNotThrow(() => validateVps(render()));
    writeFileSync(join(dir, 'docker-compose.vps.yml'), source.replace('HOST: 0.0.0.0', 'HOST: 127.0.0.1'));
    assert.throws(() => validateVps(render()), /HOST must be 0.0.0.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('healthy local endpoint does not mask public 502 or redirects', async () => {
  await verifyHttp('http://local', false, async () => new Response('ok'));
  for (const status of [301, 401, 502]) {
    await assert.rejects(verifyHttp('https://public', false, async () => new Response(null, { status })), /Health check failed/);
  }
});

test('public preflight must authorize the actual browser origin, method and headers', async () => {
  const headers = {
    'access-control-allow-origin': 'https://codex.itsnomatata.com',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
  };
  await verifyHttp('https://public', true, async (_url, init) => {
    assert.equal(init.method, 'OPTIONS');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Origin, headers['access-control-allow-origin']);
    return new Response(null, { status: 204, headers });
  });
  for (const key of Object.keys(headers)) {
    const invalid = { ...headers };
    delete invalid[key];
    await assert.rejects(verifyHttp('https://public', true, async () => new Response(null, { status: 204, headers: invalid })), /CORS/);
  }
  await assert.rejects(verifyHttp('https://public', true, async () => new Response(null, { status: 502 })), /CORS/);
});
