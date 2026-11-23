import { hasPermission } from '../authorization/permissions.js';
import type { AuthContext } from '../authorization/types.js';

export type WorkspaceArea =
  | 'attendance_own'
  | 'attendance_team'
  | 'leave_own'
  | 'leave_team'
  | 'tickets_own'
  | 'tickets_team'
  | 'documents_own'
  | 'documents_manage'
  | 'content_studio'
  | 'content_studio_approve'
  | 'chat'
  | 'chat_manage'
  | 'work'
  | 'duty_roster'
  | 'duty_roster_manage'
  | 'media'
  | 'branding'
  | 'branding_manage'
  | 'security'
  | 'directory';

const ALL_AREAS: WorkspaceArea[] = [
  'attendance_own',
  'attendance_team',
  'leave_own',
  'leave_team',
  'tickets_own',
  'tickets_team',
  'documents_own',
  'documents_manage',
  'content_studio',
  'content_studio_approve',
  'chat',
  'chat_manage',
  'work',
  'duty_roster',
  'duty_roster_manage',
  'media',
  'branding',
  'branding_manage',
  'security',
  'directory',
];

const AREA_LABEL: Record<WorkspaceArea, string> = {
  attendance_own: 'your own clock-ins',
  attendance_team: 'who clocked in across the organization',
  leave_own: 'your own leave',
  leave_team: 'other people’s leave',
  tickets_own: 'tickets you opened',
  tickets_team: 'the organization ticket queue',
  documents_own: 'documents addressed to you',
  documents_manage: 'organization documents and payslips',
  content_studio: 'Content Studio',
  content_studio_approve: 'Content Studio approval',
  chat: 'team chat',
  chat_manage: 'managing team chat',
  work: 'boards and cards',
  duty_roster: 'the duty roster',
  duty_roster_manage: 'editing the duty roster',
  media: 'media bookings',
  branding: 'organization branding',
  branding_manage: 'changing branding and domains',
  security: 'the security center',
  directory: 'the staff directory',
};

function allowed(auth: AuthContext, action: string) {
  return auth.membership.isAdminRole || hasPermission(auth.membership.permissions, action);
}

function isOperationsLead(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it'
  );
}

export function workspaceAccess(auth: AuthContext) {
  if (auth.membership.isAdminRole) {
    return {
      roleKey: auth.membership.roleKey ?? 'admin',
      admin: true,
      areas: ALL_AREAS,
    };
  }

  const areas = new Set<WorkspaceArea>();
  const lead = isOperationsLead(auth);

  if (allowed(auth, 'attendance.read') || allowed(auth, 'attendance.clock')) {
    areas.add('attendance_own');
  }
  if (lead || allowed(auth, 'attendance.manage')) {
    areas.add('attendance_own');
    areas.add('attendance_team');
    areas.add('directory');
  }

  if (allowed(auth, 'leave.read') || allowed(auth, 'leave.request')) {
    areas.add('leave_own');
  }
  if (lead || allowed(auth, 'leave.manage')) {
    areas.add('leave_own');
    areas.add('leave_team');
  }

  if (allowed(auth, 'tickets.read')) {
    areas.add('tickets_own');
  }
  if (lead || allowed(auth, 'tickets.assign')) {
    areas.add('tickets_own');
    areas.add('tickets_team');
  }

  if (allowed(auth, 'documents.read')) {
    areas.add('documents_own');
  }
  if (lead || allowed(auth, 'documents.manage')) {
    areas.add('documents_own');
    areas.add('documents_manage');
  }

  if (allowed(auth, 'content_studio.read') || allowed(auth, 'content_studio.manage')) {
    areas.add('content_studio');
  }
  if (allowed(auth, 'content_studio.approve')) {
    areas.add('content_studio');
    areas.add('content_studio_approve');
  }

  if (allowed(auth, 'chat.read') || allowed(auth, 'chat.write')) {
    areas.add('chat');
  }
  if (lead || allowed(auth, 'chat.manage')) {
    areas.add('chat');
    areas.add('chat_manage');
  }

  if (allowed(auth, 'work.boards.read') || allowed(auth, 'work.cards.read')) {
    areas.add('work');
  }
  if (allowed(auth, 'duty_roster.read')) {
    areas.add('duty_roster');
  }
  if (lead || allowed(auth, 'duty_roster.manage')) {
    areas.add('duty_roster');
    areas.add('duty_roster_manage');
  }
  if (allowed(auth, 'media.read') || allowed(auth, 'media.manage')) {
    areas.add('media');
  }
  if (allowed(auth, 'organization.branding_read')) {
    areas.add('branding');
  }
  if (lead || allowed(auth, 'organization.branding_manage')) {
    areas.add('branding');
    areas.add('branding_manage');
  }
  if (auth.membership.roleKey === 'it' || allowed(auth, 'security.view') || allowed(auth, 'security.manage')) {
    areas.add('security');
  }

  return {
    roleKey: auth.membership.roleKey ?? 'member',
    admin: false,
    areas: ALL_AREAS.filter((area) => areas.has(area)),
  };
}

export function describeWorkspaceAccess(auth: AuthContext) {
  const access = workspaceAccess(auth);
  const allowedLabels = access.areas.map((area) => AREA_LABEL[area]);
  const denied = ALL_AREAS.filter((area) => !access.areas.includes(area)).map(
    (area) => AREA_LABEL[area],
  );
  return { ...access, allowedLabels, denied };
}
