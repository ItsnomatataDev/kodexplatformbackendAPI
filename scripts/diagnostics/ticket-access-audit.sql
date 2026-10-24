-- Read-only live audit: psql "$DATABASE_URL" -v name_pattern='%Bridget%' -f this-file.sql
\set ON_ERROR_STOP on
\if :{?name_pattern}
\else
\set name_pattern '%Bridget%'
\endif
BEGIN READ ONLY;
SELECT u.id AS user_id, p.full_name, u.account_status, u.is_active,
       p.primary_role_key AS profile_role, m.organization_id, m.status AS membership_status,
       m.role_key AS membership_role, r.role_key AS permission_role, r.is_active AS role_active,
       r.permissions->'tickets' AS ticket_permissions, r.permissions->'boards' AS board_permissions,
       o.slug AS office_slug
FROM identity.users u
JOIN identity.user_profiles p ON p.user_id = u.id
LEFT JOIN organizations.memberships m ON m.user_id = u.id
LEFT JOIN organizations.roles r ON r.id = m.role_id
LEFT JOIN organizations.offices o ON o.id = m.office_id AND o.organization_id = m.organization_id
WHERE p.full_name ILIKE :'name_pattern'
ORDER BY p.full_name, m.organization_id;

SELECT t.organization_id, count(*) AS assigned_active_tickets,
       count(*) FILTER (WHERE c.id IS NULL) AS missing_linked_cards,
       count(*) FILTER (WHERE c.id IS NOT NULL AND c.assigned_to IS DISTINCT FROM t.assigned_to) AS mismatched_card_assignees,
       count(*) FILTER (WHERE NULLIF(btrim(p.full_name), '') IS NULL) AS missing_technician_names
FROM tickets.tickets t
LEFT JOIN work.cards c ON c.id=t.linked_card_id AND c.organization_id=t.organization_id
LEFT JOIN identity.user_profiles p ON p.user_id=t.assigned_to
WHERE t.assigned_to IS NOT NULL AND t.archived_at IS NULL
GROUP BY t.organization_id;

SELECT c.organization_id, count(*) AS internal_notes,
       count(*) FILTER (WHERE c.author_id IS NULL) AS missing_author_ids,
       count(*) FILTER (WHERE c.author_id IS NOT NULL AND NULLIF(btrim(p.full_name), '') IS NULL) AS missing_author_names
FROM tickets.ticket_comments c
LEFT JOIN identity.user_profiles p ON p.user_id=c.author_id
WHERE c.visibility='internal'
GROUP BY c.organization_id;
ROLLBACK;
