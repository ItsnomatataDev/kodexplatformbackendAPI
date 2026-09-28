import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { renderVps, validateVps } from './validate-vps.mjs';

export async function verifyHttp(base, cors = false, fetcher = fetch) {
  const origin = 'https://codex.itsnomatata.com';
  const response = await fetcher(`${base}/health/live`, {
    redirect: 'manual', signal: AbortSignal.timeout(10_000),
    ...(cors ? { method: 'OPTIONS', headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,content-type',
    } } : {}),
  });
  await response.body?.cancel();
  if (cors) {
    const methods = (response.headers.get('access-control-allow-methods') ?? '').split(',').map((s) => s.trim());
    const headers = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').map((s) => s.trim());
    if (![200, 204].includes(response.status)
      || response.headers.get('access-control-allow-origin') !== origin
      || !methods.includes('GET')
      || !['authorization', 'content-type'].every((h) => headers.includes(h))) {
      throw new Error('Public CORS preflight failed.');
    }
  } else if (response.status !== 200) {
    throw new Error(`Health check failed: HTTP ${response.status}.`);
  }
}

export function verifyRunningBinding() {
  // Print only HOST/PORT, never the container's complete environment.
  const binding = execFileSync('docker', ['exec', 'kode-vps-api', 'node', '-e',
    'process.stdout.write(JSON.stringify({host:process.env.HOST,port:process.env.PORT}))',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const { host, port } = JSON.parse(binding);
  if (host !== '0.0.0.0' || port !== '3000') throw new Error('Running container binding regressed; expected HOST=0.0.0.0 PORT=3000.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(validateVps(renderVps()));
    verifyRunningBinding();
    await verifyHttp('http://127.0.0.1:3000');
    await verifyHttp('https://api.tmctechsolutions.com');
    await verifyHttp('https://api.tmctechsolutions.com', true);
    console.log('Local health, public Caddy health and public CORS passed. External TCP/3000 denial must also be verified.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'VPS verification failed.');
    process.exitCode = 1;
  }
}
