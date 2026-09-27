import { parseListQuery, type ListQuery } from '../db/list-bounds.js';
import { ValidationError } from './errors.js';

export function readListQuery(c: {
  req: { query: (name: string) => string | undefined };
}): ListQuery {
  const parsed = parseListQuery({
    limit: c.req.query('limit'),
    before: c.req.query('before'),
    beforeId: c.req.query('beforeId'),
  });
  if (!parsed.ok) {
    throw new ValidationError(
      'before and beforeId must be provided together as a timestamp and id.',
    );
  }
  return parsed.query;
}
