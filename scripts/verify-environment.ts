import { env } from '../src/config/env.js';

console.log('=== KODE PLATFORM ENVIRONMENT ===');
console.log(`APP_ENV: ${env.appEnv}`);
console.log(`NODE_ENV: ${env.nodeEnv}`);
console.log(`API: ${env.host}:${env.port}`);
console.log(`ALLOW_PRODUCTION: ${env.allowProduction}`);

console.log('');
console.log('=== DATABASE ===');
console.log(`Host: ${env.database.host}`);
console.log(`Port: ${env.database.port}`);
console.log(`Database: ${env.database.name}`);
console.log(`User: ${env.database.user}`);
console.log(`TLS: ${env.database.ssl ? 'enabled' : 'disabled'}`);

console.log('');
console.log('=== REDIS ===');
console.log(`Host: ${env.redis.host}`);
console.log(`Port: ${env.redis.port}`);
console.log(`TLS: ${env.redis.tls ? 'enabled' : 'disabled'}`);
console.log(`Authentication: ${env.redis.password ? 'configured' : 'not configured'}`);
console.log(`Rate-limit namespace: kode:${env.appEnv}:ratelimit:`);

console.log('');
console.log('=== MINIO ===');
console.log(`Endpoint: ${env.minio.endpoint}`);
console.log(`Bucket: ${env.minio.bucket}`);
console.log(`Credentials: ${env.minio.accessKey && env.minio.secretKey ? 'configured' : 'not configured'}`);

console.log('');
console.log('=== AUTH ===');
console.log(`Issuer: ${env.auth.issuer}`);
console.log(`Audience: ${env.auth.audience}`);
console.log(`Access token TTL seconds: ${env.auth.accessTokenTtlSeconds}`);
console.log(`Refresh token TTL seconds: ${env.auth.refreshTokenTtlSeconds}`);
console.log(`Password reset TTL seconds: ${env.auth.passwordResetTtlSeconds}`);

console.log('');
console.log('=== EMAIL ===');
console.log(`Provider: ${env.email.provider}`);
if (env.email.provider === 'smtp') {
  console.log(`SMTP host: ${env.email.host}`);
  console.log(`SMTP port: ${env.email.port}`);
  console.log(`SMTP TLS: ${env.email.secure ? 'smtps' : 'starttls-or-plain'}`);
  console.log('SMTP credentials: configured');
}

console.log('');
console.log('=== CORS ===');
console.log(`Allowed origins: ${env.cors.allowedOrigins.join(', ')}`);

console.log('');
console.log('=== REQUEST LIMITS ===');
console.log(`Max request body bytes: ${env.limits.maxRequestBodyBytes}`);
console.log(`Max attachment bytes: ${env.limits.maxAttachmentBytes}`);
console.log(
  `Trusted proxy IPs: ${env.trustedProxyIps.length > 0 ? env.trustedProxyIps.join(', ') : '(none)'}`,
);

console.log('');
console.log('Isolation guards passed. Secrets are not printed.');
console.log('Environment configuration loaded successfully.');
