import 'dotenv/config';

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port,
  host: process.env.HOST ?? '127.0.0.1',
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
