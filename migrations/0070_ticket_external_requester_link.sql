-- Public tickets belong to the requester's account once that email is an active member of the ticket's organization.
CREATE OR REPLACE FUNCTION tickets.link_external_tickets_to_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  linked integer;
BEGIN
  UPDATE tickets.tickets t
  SET user_id = u.id
  FROM identity.users u
  JOIN organizations.memberships m
    ON m.user_id = u.id AND m.status = 'active'
  WHERE u.id = p_user_id
    AND u.account_status = 'active'
    AND u.is_active
    AND u.deleted_at IS NULL
    AND u.email_normalized IS NOT NULL
    AND t.organization_id = m.organization_id
    AND t.requester_type = 'external'
    AND t.user_id IS NULL
    AND lower(btrim(t.requester_email)) = u.email_normalized;
  GET DIAGNOSTICS linked = ROW_COUNT;
  RETURN linked;
END $$;

CREATE OR REPLACE FUNCTION tickets.link_new_external_ticket() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NULL
    AND NEW.requester_type = 'external'
    AND NEW.requester_email IS NOT NULL THEN
    SELECT u.id INTO NEW.user_id
    FROM identity.users u
    JOIN organizations.memberships m
      ON m.user_id = u.id
      AND m.organization_id = NEW.organization_id
      AND m.status = 'active'
    WHERE u.email_normalized = lower(btrim(NEW.requester_email))
      AND u.account_status = 'active'
      AND u.is_active
      AND u.deleted_at IS NULL
    LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION tickets.link_external_tickets_on_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM tickets.link_external_tickets_to_user(NEW.user_id);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION tickets.link_external_tickets_on_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM tickets.link_external_tickets_to_user(NEW.id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ticket_link_external_requester ON tickets.tickets;
CREATE TRIGGER ticket_link_external_requester
BEFORE INSERT ON tickets.tickets
FOR EACH ROW EXECUTE FUNCTION tickets.link_new_external_ticket();

DROP TRIGGER IF EXISTS membership_link_external_tickets ON organizations.memberships;
CREATE TRIGGER membership_link_external_tickets
AFTER INSERT OR UPDATE OF status ON organizations.memberships
FOR EACH ROW WHEN (NEW.status = 'active')
EXECUTE FUNCTION tickets.link_external_tickets_on_membership();

DROP TRIGGER IF EXISTS user_link_external_tickets ON identity.users;
CREATE TRIGGER user_link_external_tickets
AFTER UPDATE OF account_status, is_active ON identity.users
FOR EACH ROW WHEN (NEW.account_status = 'active' AND NEW.is_active)
EXECUTE FUNCTION tickets.link_external_tickets_on_user();

SELECT tickets.link_external_tickets_to_user(u.id)
FROM identity.users u
WHERE u.account_status = 'active' AND u.is_active AND u.deleted_at IS NULL;
