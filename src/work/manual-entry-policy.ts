import { harareDateKey, harareDayRange } from '../attendance/harare.js';
import type { AuthContext } from '../authorization/types.js';
import type { ManualEntrySettings, VehicleShootMatch, WorkStore } from './store.js';

export const MANUAL_ENTRY_REASON_MIN_LENGTH = 15;
export const MANUAL_ENTRY_MAX_SECONDS = 24 * 60 * 60;
/** Timers may start a little in the past to absorb clock drift, never hours earlier. */
export const TIMER_BACKDATE_TOLERANCE_MS = 5 * 60 * 1000;

export type ManualEntryPolicySource = Pick<WorkStore, 'getManualEntrySettings' | 'findVehicleShootForDay'>;

export type ManualEntryAccess = {
  manualEntriesEnabled: boolean;
  exempt: boolean;
  shootBooking: VehicleShootMatch | null;
  mode: 'direct' | 'approval';
};

type PolicyAuth = Pick<AuthContext, 'membership'>;

/** Admin and IT own the switch, so the restriction does not apply to their own time. */
export function canManageManualEntrySettings(auth: PolicyAuth) {
  return auth.membership.isAdminRole || auth.membership.roleKey === 'it';
}

export function canReviewManualTime(auth: PolicyAuth) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it'
  );
}

export async function resolveManualEntryAccess(
  source: ManualEntryPolicySource,
  auth: PolicyAuth,
  userId: string,
  at: Date,
  settings?: ManualEntrySettings,
): Promise<ManualEntryAccess> {
  const organizationId = auth.membership.organizationId;
  const current = settings ?? (await source.getManualEntrySettings(organizationId));
  const exempt = canManageManualEntrySettings(auth);
  if (current.manualEntriesEnabled || exempt) {
    return {
      manualEntriesEnabled: current.manualEntriesEnabled,
      exempt,
      shootBooking: null,
      mode: 'direct',
    };
  }
  const { start, end } = harareDayRange(harareDateKey(at));
  const shootBooking = await source.findVehicleShootForDay(organizationId, userId, start, end);
  return {
    manualEntriesEnabled: false,
    exempt: false,
    shootBooking,
    mode: shootBooking ? 'direct' : 'approval',
  };
}

export function isValidManualEntryReason(reason: string | null | undefined) {
  return (reason?.trim().length ?? 0) >= MANUAL_ENTRY_REASON_MIN_LENGTH;
}
