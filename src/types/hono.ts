import type { Logger } from 'pino';
import type { AuthContext } from '../authorization/types.js';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    logger: Logger;
    auth: AuthContext;
    sessionId: string;
  }
}
