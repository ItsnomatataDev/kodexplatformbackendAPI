import { hasPermission } from '../authorization/permissions.js';
import type { AuthContext } from '../authorization/types.js';
import { parseTimeRequest } from './time-actions.js';
import { workspaceAccess, type WorkspaceArea } from './role-access.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PLACEHOLDER_RECORDS = new Set([
  'certain',
  'certain client',
  'a certain client',
  'some client',
  'a client',
  'the client',
  'that client',
  'this client',
  'my client',
  'certain board',
  'a board',
  'the board',
  'that board',
  'one',
  'something',
]);

export type NavigationMatch = {
  id: string;
  name: string;
};

export type NavigationSource = {
  findContentClients(
    organizationId: string,
    officeId: string | null,
    query: string,
  ): Promise<NavigationMatch[]>;
  findBoards(organizationId: string, query: string): Promise<NavigationMatch[]>;
};

export type WorkspaceNavigation = {
  path: string;
  label: string;
};

type NavigationResult = {
  reply: string;
  navigation: WorkspaceNavigation | null;
};

type RecordKind = 'content_client' | 'board';

type NavRoute = {
  label: string;
  path: string;
  aliases: string[];
  allow: (auth: AuthContext) => boolean;
  record?: RecordKind;
};

function area(auth: AuthContext, name: WorkspaceArea) {
  return workspaceAccess(auth).areas.includes(name);
}

function lead(auth: AuthContext) {
  return auth.membership.isAdminRole || auth.membership.isManagerRole || auth.membership.roleKey === 'it';
}

function can(auth: AuthContext, action: string) {
  return auth.membership.isAdminRole || hasPermission(auth.membership.permissions, action);
}

const ROUTES: NavRoute[] = [
  { label: 'Dashboard', path: '/dashboard', aliases: ['dashboard', 'home'], allow: () => true },
  { label: 'Inbox', path: '/inbox', aliases: ['inbox'], allow: () => true },
  { label: 'Calendar', path: '/calendar', aliases: ['calendar'], allow: () => true },
  { label: 'My Schedule', path: '/my-schedule', aliases: ['my schedule', 'schedule'], allow: () => true },
  { label: 'Settings', path: '/settings', aliases: ['settings'], allow: () => true },
  { label: 'Profile', path: '/profile', aliases: ['profile', 'my profile'], allow: () => true },
  { label: 'Notifications', path: '/notifications', aliases: ['notifications', 'notification'], allow: () => true },
  { label: 'AI Workspace', path: '/ai-workspace', aliases: ['ai workspace', 'workspace ai'], allow: () => true },
  { label: 'AI Assistant', path: '/ai-assistant', aliases: ['ai assistant'], allow: () => true },
  { label: 'University', path: '/university', aliases: ['university'], allow: () => true },
  { label: 'Boards', path: '/boards', aliases: ['boards', 'board', 'kanban', 'tasks'], allow: (auth) => area(auth, 'work'), record: 'board' },
  { label: 'Board timeline', path: '/boards/timeline', aliases: ['board timeline', 'timeline'], allow: (auth) => area(auth, 'work') },
  { label: 'Time entries', path: '/time-entries', aliases: ['time entries', 'time entry', 'timesheet', 'timesheets', 'time tracking', 'time'], allow: (auth) => can(auth, 'work.time_entries.read') },
  { label: 'Leave', path: '/leave', aliases: ['leave', 'leave requests'], allow: (auth) => area(auth, 'leave_own') },
  { label: 'Attendance', path: '/attendance', aliases: ['attendance', 'clock in', 'clock-ins'], allow: (auth) => area(auth, 'attendance_own') },
  { label: 'Team Chat', path: '/chat', aliases: ['team chat', 'chat'], allow: (auth) => area(auth, 'chat') },
  { label: 'Meetings', path: '/meetings', aliases: ['meetings', 'meeting'], allow: () => true },
  { label: 'My Support', path: '/my-support', aliases: ['my support', 'support', 'my tickets', 'tickets'], allow: (auth) => area(auth, 'tickets_own') },
  { label: 'Obligations', path: '/obligations', aliases: ['obligations', 'obligation'], allow: () => true },
  { label: 'Duty Roster', path: '/roster', aliases: ['duty roster', 'roster'], allow: (auth) => area(auth, 'duty_roster') },
  { label: 'Content Studio', path: '/content-studio/clients', aliases: ['content studio', 'content-studio'], allow: (auth) => area(auth, 'content_studio'), record: 'content_client' },
  { label: 'Social Posts', path: '/social-posts', aliases: ['social posts', 'social post'], allow: (auth) => area(auth, 'content_studio') || area(auth, 'media') },
  { label: 'Media Dashboard', path: '/media-dashboard', aliases: ['media dashboard', 'media'], allow: (auth) => area(auth, 'media') },
  { label: 'Shoot bookings', path: '/shoot-bookings', aliases: ['shoot bookings', 'book shoots', 'shoots'], allow: (auth) => area(auth, 'media') },
  { label: 'Creative Requests', path: '/creative-requests', aliases: ['creative requests'], allow: (auth) => area(auth, 'media') },
  { label: 'Production Pipeline', path: '/production-pipeline', aliases: ['production pipeline'], allow: (auth) => area(auth, 'media') },
  { label: 'Campaign Visuals', path: '/campaign-visuals', aliases: ['campaign visuals'], allow: (auth) => area(auth, 'media') },
  { label: 'Editing Queue', path: '/editing-queue', aliases: ['editing queue'], allow: (auth) => area(auth, 'media') },
  { label: 'Delivery Tracker', path: '/delivery-tracker', aliases: ['delivery tracker'], allow: (auth) => area(auth, 'media') },
  { label: 'Assets', path: '/assets', aliases: ['assets', 'asset', 'stock', 'inventory'], allow: () => true },
  { label: 'Scan asset', path: '/scan', aliases: ['scan asset', 'scan'], allow: () => true },
  { label: 'Clients', path: '/clients', aliases: ['clients', 'client'], allow: () => true },
  { label: 'Reports', path: '/reports', aliases: ['reports', 'report'], allow: () => true },
  { label: 'Fleet', path: '/fleet', aliases: ['fleet', 'vehicles', 'vehicle'], allow: lead },
  { label: 'Tourism', path: '/tourism', aliases: ['tourism', 'tourism operations'], allow: lead },
  { label: 'Tourism bookings', path: '/tourism/bookings', aliases: ['tourism bookings'], allow: lead },
  { label: 'Itineraries', path: '/tourism/itineraries', aliases: ['itineraries', 'itinerary'], allow: lead },
  { label: 'Guests', path: '/tourism/guests', aliases: ['guests', 'guest list'], allow: lead },
  { label: 'Transfers', path: '/tourism/transfers', aliases: ['transfers', 'transfer'], allow: lead },
  { label: 'Location planner', path: '/location-planner', aliases: ['location planner'], allow: lead },
  { label: 'Organization settings', path: '/organization/settings', aliases: ['organization settings', 'org settings'], allow: (auth) => auth.membership.isAdminRole || auth.membership.roleKey === 'it' },
  { label: 'Team directory', path: '/organization/team', aliases: ['team directory', 'directory', 'employees'], allow: (auth) => lead(auth) || area(auth, 'directory') },
  { label: 'Admin dashboard', path: '/admin/dashboard', aliases: ['admin dashboard'], allow: lead },
  { label: 'Operations Center', path: '/operations-center', aliases: ['operations center', 'operations'], allow: lead },
  { label: 'Security', path: '/admin/security', aliases: ['security', 'security center', 'security control center'], allow: (auth) => area(auth, 'security') },
  { label: 'Service Desk', path: '/it/support', aliases: ['service desk', 'it support'], allow: (auth) => auth.membership.isAdminRole || auth.membership.roleKey === 'it' },
  { label: 'IT dashboard', path: '/it/dashboard', aliases: ['it dashboard', 'control centre', 'control center'], allow: (auth) => auth.membership.isAdminRole || auth.membership.roleKey === 'it' },
  { label: 'Automations', path: '/automations', aliases: ['automations', 'automation'], allow: lead },
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function navigationTarget(message: string) {
  let text = message.trim().replace(/[?.!]+$/g, '');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = text.replace(/^(?:hey|hi|ok|okay|kodex|codex|please|kindly|can you|could you|would you)\s+/i, '');
    if (next === text) break;
    text = next;
  }
  const match = text.match(/^(?:open|go to|take me to|show me|navigate to|bring up|launch|switch to)\s+(?:the\s+|my\s+|our\s+)?([\s\S]{2,160})$/i);
  if (!match) return null;
  return match[1]
    .replace(/\b(windows?|screens?|pages?|tabs?|wind)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchRoute(target: string) {
  const normalized = target.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized || /\b(who|what|why|when|how|which|whether)\b/.test(normalized)) return null;
  const entries = ROUTES.flatMap((route) => route.aliases.map((alias) => ({ route, alias })));
  entries.sort((left, right) => right.alias.length - left.alias.length);
  for (const entry of entries) {
    if (normalized === entry.alias) return { route: entry.route, rest: '' };
    if (normalized.startsWith(`${entry.alias} `)) {
      return { route: entry.route, rest: normalized.slice(entry.alias.length).trim() };
    }
    const inside = normalized.match(new RegExp(`^(.{2,80}?)\\s+in\\s+${escapeRegExp(entry.alias)}$`));
    if (inside?.[1]) return { route: entry.route, rest: inside[1].trim() };
  }
  const recordEntries = entries.filter((entry) => entry.route.record);
  for (const entry of recordEntries) {
    const named = normalized.match(new RegExp(`^(.{2,80}?)\\s+${escapeRegExp(entry.alias)}$`));
    if (named?.[1]) return { route: entry.route, rest: named[1].trim() };
  }
  return null;
}

function recordQuery(rest: string) {
  let value = rest.trim();
  const filler = /^(?:and|then|open|the|a|an|my|our|client|clients|board|boards|called|named|for|to)\b\s*/i;
  while (filler.test(value)) value = value.replace(filler, '').trim();
  value = value.replace(/[?.!,"“”]+$/g, '').trim();
  if (value.length < 2 || PLACEHOLDER_RECORDS.has(value.toLowerCase())) return null;
  return value;
}

function pickMatch(matches: NavigationMatch[], query: string) {
  const expected = query.trim().toLowerCase();
  const exact = matches.filter((match) => match.name.trim().toLowerCase() === expected);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return 'many' as const;
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return 'none' as const;
  return 'many' as const;
}

function opened(route: NavRoute, path = route.path, label = route.label): NavigationResult {
  return {
    reply: `Opening ${label}.`,
    navigation: { path, label },
  };
}

function safeRecordPath(route: NavRoute, id: string) {
  if (!UUID.test(id)) return null;
  if (route.record === 'content_client') return `/content-studio/clients/${id}`;
  if (route.record === 'board') return `/boards/${id}`;
  return null;
}

export async function resolveWorkspaceNavigation(
  auth: AuthContext,
  message: string,
  source: NavigationSource,
): Promise<NavigationResult | null> {
  if (parseTimeRequest(message)) return null;
  if (/https?:\/\//i.test(message) || /\bwww\./i.test(message)) return null;
  const target = navigationTarget(message);
  if (!target) return null;
  try {
    const matched = matchRoute(target);
    if (!matched) {
      return {
        reply: `I don't know a workspace page called ${target}. Nothing was opened.`,
        navigation: null,
      };
    }
    const { route, rest } = matched;
    if (!route.allow(auth)) {
      return {
        reply: `This role cannot open ${route.label}. Nothing was opened.`,
        navigation: null,
      };
    }
    const query = route.record && rest ? recordQuery(rest) : null;
    if (route.record && rest && !query) {
      return {
        reply: `Opening ${route.label}. Tell me the exact name if you want one ${route.record === 'board' ? 'board' : 'client'}.`,
        navigation: { path: route.path, label: route.label },
      };
    }
    if (!query || !route.record) return opened(route);
    const matches = route.record === 'content_client'
      ? await source.findContentClients(auth.membership.organizationId, auth.membership.officeId, query)
      : await source.findBoards(auth.membership.organizationId, query);
    const picked = pickMatch(matches, query);
    if (picked === 'none') {
      return {
        reply: `I could not find ${query} in ${route.label}. Nothing was opened.`,
        navigation: null,
      };
    }
    if (picked === 'many') {
      const names = matches.slice(0, 8).map((match) => match.name).join(', ');
      return {
        reply: `More than one match for ${query}: ${names}. Name the exact one. Nothing was opened.`,
        navigation: null,
      };
    }
    const path = safeRecordPath(route, picked.id);
    if (!path) return { reply: 'That record cannot be opened. Nothing was opened.', navigation: null };
    return opened(route, path, `${route.label}, ${picked.name}`);
  } catch {
    return { reply: 'I could not open that page just now. Nothing was opened.', navigation: null };
  }
}
