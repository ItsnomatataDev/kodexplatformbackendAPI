CREATE TABLE IF NOT EXISTS organizations.offices (
    id UUID PRIMARY KEY,

    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,

    name TEXT NOT NULL,
    slug TEXT NOT NULL,

    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    settings JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    legacy_source TEXT,
    legacy_id UUID,

    CONSTRAINT offices_organization_slug_unique
        UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS offices_organization_idx
    ON organizations.offices (organization_id);

CREATE INDEX IF NOT EXISTS offices_organization_active_idx
    ON organizations.offices (organization_id, is_active);

ALTER TABLE organizations.memberships
    ADD COLUMN IF NOT EXISTS office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS memberships_office_idx
    ON organizations.memberships (office_id);


CREATE OR REPLACE FUNCTION organizations.membership_office_same_org()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.office_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM organizations.offices office
        WHERE office.id = NEW.office_id
          AND office.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION
            'membership office_id must belong to the same organization'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memberships_office_same_org
    ON organizations.memberships;

CREATE TRIGGER memberships_office_same_org
    BEFORE INSERT OR UPDATE OF office_id, organization_id
    ON organizations.memberships
    FOR EACH ROW
    EXECUTE FUNCTION organizations.membership_office_same_org();


CREATE OR REPLACE FUNCTION organizations.office_org_matches_memberships()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM organizations.memberships membership
        WHERE membership.office_id = NEW.id
          AND membership.organization_id <> NEW.organization_id
    ) THEN
        RAISE EXCEPTION
            'office organization_id cannot change while memberships reference it from another organization'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS offices_org_matches_memberships
    ON organizations.offices;

CREATE TRIGGER offices_org_matches_memberships
    BEFORE UPDATE OF organization_id
    ON organizations.offices
    FOR EACH ROW
    EXECUTE FUNCTION organizations.office_org_matches_memberships();


DO $$
DECLARE
    skipped RECORD;
    created_count INTEGER := 0;
    updated_count INTEGER := 0;
BEGIN
    FOR skipped IN
        SELECT
            profile.office_id,
            COUNT(DISTINCT membership.organization_id) AS organization_count
        FROM identity.user_profiles profile
        LEFT JOIN organizations.memberships membership
            ON membership.user_id = profile.user_id
        WHERE profile.office_id IS NOT NULL
        GROUP BY profile.office_id
        HAVING COUNT(DISTINCT membership.organization_id) <> 1
    LOOP
        RAISE NOTICE
            'OFFICE BACKFILL SKIPPED — office_id=% cannot be proven to belong to a single organization (organization_count=%)',
            skipped.office_id,
            skipped.organization_count;
    END LOOP;

    INSERT INTO organizations.offices (
        id,
        organization_id,
        name,
        slug,
        is_primary,
        is_active,
        settings,
        legacy_source,
        legacy_id
    )
    SELECT
        proven.id,
        proven.organization_id,
        'Imported office',
        proven.id::text,
        FALSE,
        TRUE,
        '{}'::jsonb,
        'user_profiles.office_id',
        proven.id
    FROM (
        SELECT
            profile.office_id AS id,
            MIN(membership.organization_id::text)::uuid AS organization_id
        FROM identity.user_profiles profile
        INNER JOIN organizations.memberships membership
            ON membership.user_id = profile.user_id
        WHERE profile.office_id IS NOT NULL
        GROUP BY profile.office_id
        HAVING COUNT(DISTINCT membership.organization_id) = 1
    ) proven
    ON CONFLICT (id) DO NOTHING;

    GET DIAGNOSTICS created_count = ROW_COUNT;

    UPDATE organizations.memberships membership
    SET
        office_id = profile.office_id,
        updated_at = NOW()
    FROM identity.user_profiles profile
    INNER JOIN organizations.offices office
        ON office.id = profile.office_id
    WHERE membership.user_id = profile.user_id
      AND profile.office_id IS NOT NULL
      AND office.organization_id = membership.organization_id
      AND membership.office_id IS NULL;

    GET DIAGNOSTICS updated_count = ROW_COUNT;

    RAISE NOTICE
        'OFFICE BACKFILL created=% memberships_updated=%',
        created_count,
        updated_count;
END
$$;


COMMENT ON TABLE organizations.offices IS
    'Organization offices. Membership.office_id is the authoritative assignment.';

COMMENT ON COLUMN organizations.memberships.office_id IS
    'Authoritative office assignment for the membership. Nullable until every membership has a proven office.';
