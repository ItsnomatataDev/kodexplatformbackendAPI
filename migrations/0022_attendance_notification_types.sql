ALTER TABLE notifications.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'task_assigned',
    'task_comment',
    'attendance_clock_in_reminder',
    'attendance_late',
    'attendance_auto_clock_out'
  ));
