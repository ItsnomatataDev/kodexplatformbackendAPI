export const ATTENDANCE_SESSION_STATUSES = [
  'active',
  'completed',
  'missed_clock_out',
] as const;

export const ATTENDANCE_DAILY_STATUSES = [
  'present',
  'late',
  'absent',
  'on_leave',
  'pending',
] as const;

export type AttendanceSessionStatus =
  (typeof ATTENDANCE_SESSION_STATUSES)[number];
export type AttendanceDailyStatusValue =
  (typeof ATTENDANCE_DAILY_STATUSES)[number];

export type AttendanceSessionRecord = {
  id: string;
  organizationId: string;
  officeId: string | null;
  userId: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  status: AttendanceSessionStatus;
  workSeconds: number;
  clockInMethod: string;
  clockOutMethod: string | null;
  notes: string | null;
  ipAddress: string | null;
  deviceInfo: Record<string, unknown>;
  location: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  userName?: string | null;
  userEmail?: string | null;
};

export type AttendanceDailyStatusRecord = {
  id: string;
  organizationId: string;
  officeId: string | null;
  userId: string;
  attendanceDate: string;
  status: AttendanceDailyStatusValue;
  expectedClockInAt: Date | null;
  actualClockInAt: Date | null;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AttendanceMemberRecord = {
  userId: string;
  fullName: string | null;
  email: string | null;
  officeId: string | null;
  officeSlug: string | null;
  officeSettings: Record<string, unknown>;
  roleKey: string | null;
};

export type ClockInSessionInput = {
  organizationId: string;
  userId: string;
  officeId?: string | null;
  method?: string;
  notes?: string | null;
  ipAddress?: string | null;
  deviceInfo?: Record<string, unknown>;
  location?: Record<string, unknown>;
  clockInAt?: Date;
};

export type ClockOutSessionInput = {
  sessionId: string;
  organizationId: string;
  method?: string;
  notes?: string | null;
  clockOutAt?: Date;
  workSeconds: number;
};

export type ListSessionsInput = {
  organizationId: string;
  userId?: string | null;
  officeId?: string | null;
  from: Date;
  to: Date;
  limit?: number;
  /** Include sessions that are still open or clocked out inside the window, even if clock-in started earlier. */
  overlap?: boolean;
};

export type UpsertDailyStatusInput = {
  organizationId: string;
  userId: string;
  officeId?: string | null;
  attendanceDate: string;
  status: AttendanceDailyStatusValue;
  expectedClockInAt?: Date | null;
  actualClockInAt?: Date | null;
  sessionId?: string | null;
};

export interface AttendanceStore {
  getActiveSession(
    organizationId: string,
    userId: string,
  ): Promise<AttendanceSessionRecord | null>;
  getSessionById(
    organizationId: string,
    sessionId: string,
  ): Promise<AttendanceSessionRecord | null>;
  listSessions(input: ListSessionsInput): Promise<AttendanceSessionRecord[]>;
  clockIn(input: ClockInSessionInput): Promise<AttendanceSessionRecord>;
  clockOut(input: ClockOutSessionInput): Promise<AttendanceSessionRecord>;
  upsertDailyStatus(
    input: UpsertDailyStatusInput,
  ): Promise<AttendanceDailyStatusRecord>;
  listDailyStatus(input: {
    organizationId: string;
    attendanceDate: string;
    userId?: string | null;
    officeId?: string | null;
  }): Promise<AttendanceDailyStatusRecord[]>;
  listMembers(organizationId: string): Promise<AttendanceMemberRecord[]>;
  getMemberOfficeSettings(
    organizationId: string,
    userId: string,
  ): Promise<{
    officeId: string | null;
    settings: Record<string, unknown>;
  } | null>;
  getOrganizationSettings(
    organizationId: string,
  ): Promise<Record<string, unknown>>;
}
