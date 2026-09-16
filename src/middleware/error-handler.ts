import type { Context } from 'hono';

export function errorHandler(err: Error, c: Context) {
  console.error(err);

  return c.json(
    {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred.',
      },
    },
    500,
  );
}
