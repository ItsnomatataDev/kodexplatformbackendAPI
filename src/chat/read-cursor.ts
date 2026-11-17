/**
 * Stage C: conversation read-cursor helpers.
 * A read cursor must only move forward by message time.
 */

export function shouldAdvanceReadCursor(params: {
  currentCursorAt: Date | null;
  currentMessageId: string | null;
  targetMessageId: string;
  targetCreatedAt: Date;
}): boolean {
  if (params.currentMessageId && params.currentMessageId === params.targetMessageId) {
    return false;
  }
  if (!params.currentCursorAt) return true;
  return params.targetCreatedAt.getTime() >= params.currentCursorAt.getTime();
}
