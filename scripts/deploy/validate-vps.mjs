import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** Validate rendered configuration without printing runtime secrets. */
export function validateVps(config) {
  const services = config.services ?? {};
  const api = services.api ?? {};
  const environment = api.environment ?? {};
  requireValue(api.network_mode === 'host', 'VPS API must retain host networking for loopback dependencies.');
  requireValue(environment.HOST === '0.0.0.0', 'VPS API HOST must be 0.0.0.0; loopback-only binding breaks the observed Caddy path.');
  requireValue(String(environment.PORT) === '3000', 'VPS API PORT must be 3000.');
  requireValue(environment.APP_ENV === 'staging' && environment.NODE_ENV === 'staging', 'VPS loopback topology requires the existing staging environment.');
  requireValue(!api.ports?.length, 'Host-network API must not declare Docker port publishing.');
  for (const [name, ports] of [['postgres', [5432]], ['redis', [6379]], ['minio', [9000, 9001]]]) {
    const published = services[name]?.ports ?? [];
    for (const target of ports) {
      requireValue(published.some((port) => Number(port.target) === target), `Missing ${name} port ${target}.`);
    }
    requireValue(published.every((port) => port.host_ip === '127.0.0.1'), `${name} must publish only on host loopback.`);
  }
  // Never print the full rendered configuration: it contains secrets.
  return 'VPS configuration valid: HOST=0.0.0.0 PORT=3000 network_mode=host. Firewall and public-path checks are still required.';
}

export function renderVps() {
  try {
    return JSON.parse(execFileSync('docker', [
      'compose', '--env-file', '.env.vps', '-f', 'docker-compose.vps.yml', 'config', '--format', 'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    throw new Error('Cannot render VPS Compose configuration. Check Docker Compose and .env.vps locally; rendered secrets are intentionally withheld.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(validateVps(renderVps()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
