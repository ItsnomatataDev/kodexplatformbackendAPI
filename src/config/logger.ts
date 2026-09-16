import pino from 'pino';
import { env } from './env.js';
import { logRedactCensor, logRedactPaths } from './redaction.js';

export const logger = pino({
  level: env.logLevel,
  base: {
    service: 'kode-platform',
    env: env.appEnv,
  },
  redact: {
    paths: [...logRedactPaths],
    censor: logRedactCensor,
  },
  transport:
    env.appEnv === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});
