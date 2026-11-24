import type { AuthContext } from '../authorization/types.js';
import { ForbiddenError, NotFoundError } from '../http/errors.js';
import type { BoardRecord, CardRecord, WorkStore } from './store.js';

const OFFICE_SCOPED_WORK_ROLES = new Set(['media_team', 'social_media']);

export function workOfficeScope(auth: AuthContext): string | null {
  const roleKey = auth.membership.roleKey?.trim().toLowerCase() ?? '';
  if (!OFFICE_SCOPED_WORK_ROLES.has(roleKey)) return null;

  if (!auth.membership.officeId) {
    throw new ForbiddenError(
      'OFFICE_ASSIGNMENT_REQUIRED',
      'An active office assignment is required to access work data.',
    );
  }

  return auth.membership.officeId;
}

export function boardOfficeId(board: BoardRecord): string | null {
  if (!board.metadata || typeof board.metadata !== 'object' || Array.isArray(board.metadata)) {
    return null;
  }

  const metadata = board.metadata as Record<string, unknown>;
  for (const candidate of [metadata.officeId, metadata.office_id]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export function assertBoardOfficeAccess(
  auth: AuthContext,
  board: BoardRecord,
): void {
  const officeId = workOfficeScope(auth);
  if (officeId && boardOfficeId(board) !== officeId) {
    throw new NotFoundError('BOARD_NOT_FOUND', 'The board was not found.');
  }
}

export async function assertCardOfficeAccess(
  auth: AuthContext,
  store: WorkStore,
  organizationId: string,
  card: CardRecord,
): Promise<void> {
  const officeId = workOfficeScope(auth);
  if (!officeId) return;

  if (card.legacyOfficeId && card.legacyOfficeId !== officeId) {
    throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
  }

  const board = await store.getById(organizationId, card.boardId);
  if (!board || boardOfficeId(board) !== officeId) {
    throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
  }
}
