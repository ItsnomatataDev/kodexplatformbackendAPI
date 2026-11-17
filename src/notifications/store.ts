export const NOTIFICATION_TYPES = {
  taskAssigned: 'task_assigned',
  taskComment: 'task_comment',
  ticketComment: 'ticket_comment',
  ticketAssigned: 'ticket_assigned',
  ticketWaiting: 'ticket_waiting_for_requester',
  ticketResolved: 'ticket_resolved',
  ticketFollowUp: 'ticket_follow_up',
  chatMessage: 'chat_message',
  attendanceClockInReminder: 'attendance_clock_in_reminder',
  attendanceLate: 'attendance_late',
  attendanceAutoClockOut: 'attendance_auto_clock_out',
  locationPlannerMonthEnd: 'location_planner_month_end',
} as const;

export type NotificationType = string;

export type NotificationRecord = {
  id: string;
  organizationId: string;
  recipientUserId: string;
  actorUserId: string | null;
  type: NotificationType;
  title: string;
  message: string | null;
  entityType: string;
  entityId: string;
  actionUrl: string | null;
  priority: string;
  category: string | null;
  dedupeKey: string | null;
  metadata: Record<string, unknown>;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
};

export type CreateNotificationInput = {
  organizationId: string;
  recipientUserId: string;
  actorUserId?: string | null;
  type: NotificationType;
  title: string;
  message?: string | null;
  entityType: string;
  entityId: string;
  actionUrl?: string | null;
  priority?: string;
  category?: string | null;
  dedupeKey?: string | null;
  metadata?: Record<string, unknown>;
};

export type ListNotificationsInput = {
  organizationId: string;
  recipientUserId: string;
  unreadOnly?: boolean;
  limit?: number;
};

export interface NotificationStore {
  list(input: ListNotificationsInput): Promise<NotificationRecord[]>;
  countUnread(organizationId: string, recipientUserId: string): Promise<number>;
  getById(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ): Promise<NotificationRecord | null>;
  create(
    input: CreateNotificationInput,
  ): Promise<NotificationRecord | 'duplicate'>;
  markRead(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ): Promise<NotificationRecord | null>;
  markAllRead(
    organizationId: string,
    recipientUserId: string,
  ): Promise<number>;
  getDisplayName(userId: string): Promise<string | null>;
  getRecipientEmails(
    userIds: string[],
    organizationId?: string,
  ): Promise<Map<string, { email: string; fullName: string | null }>>;
  assertActiveOrgRecipients(
    organizationId: string,
    userIds: string[],
  ): Promise<void>;
  findActiveMemberByEmail(
    organizationId: string,
    email: string,
  ): Promise<{ userId: string; email: string } | null>;
}
