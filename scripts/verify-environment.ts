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

console.log('');
console.log('=== REDIS ===');
console.log(`Host: ${env.redis.host}`);
console.log(`Port: ${env.redis.port}`);

console.log('');
console.log('=== MINIO ===');
console.log(`Endpoint: ${env.minio.endpoint}`);
console.log(`Bucket: ${env.minio.bucket}`);

console.log('');
console.log('=== AUTH ===');
console.log(`Issuer: ${env.auth.issuer}`);
console.log(`Audience: ${env.auth.audience}`);
console.log(`Access token TTL seconds: ${env.auth.accessTokenTtlSeconds}`);
console.log(`Refresh token TTL seconds: ${env.auth.refreshTokenTtlSeconds}`);
console.log(`Password reset TTL seconds: ${env.auth.passwordResetTtlSeconds}`);

console.log('');
console.log('=== CORS ===');
console.log(`Allowed origins: ${env.cors.allowedOrigins.join(', ')}`);

console.log('');
console.log('Isolation guards passed. Secrets are not printed.');
console.log('Environment configuration loaded successfully.');
