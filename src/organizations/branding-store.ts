import { randomUUID } from 'node:crypto';
import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

export type BrandingRecord = {
  organizationId: string;
  brandName: string | null;
  appName: string | null;
  logoUrl: string | null;
  logoObjectKey: string | null;
  faviconUrl: string | null;
  faviconObjectKey: string | null;
  loginBackgroundUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  backgroundColor: string | null;
  cardColor: string | null;
  sidebarColor: string | null;
  topbarColor: string | null;
  textColor: string | null;
  mutedTextColor: string | null;
  borderColor: string | null;
  buttonColor: string | null;
  buttonTextColor: string | null;
  buttonHoverColor: string | null;
  linkColor: string | null;
  linkHoverColor: string | null;
  inputFocusColor: string | null;
  companySlogan: string | null;
  companyWelcomeText: string | null;
  dashboardGreetingText: string | null;
  customTerminology: Record<string, unknown>;
  invitationTemplate: string | null;
  onboardingWording: Record<string, unknown>;
  customCss: Record<string, unknown>;
  isActive: boolean;
  customDomain: string | null;
  subdomain: string | null;
  dnsTarget: string | null;
  domainError: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  organizationStatus: string | null;
  organizationAccessStatus: string | null;
  organizationIsActive: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BrandingPatch = Partial<{
  brandName: string | null;
  appName: string | null;
  logoUrl: string | null;
  logoObjectKey: string | null;
  faviconUrl: string | null;
  faviconObjectKey: string | null;
  loginBackgroundUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  backgroundColor: string | null;
  cardColor: string | null;
  sidebarColor: string | null;
  topbarColor: string | null;
  textColor: string | null;
  mutedTextColor: string | null;
  borderColor: string | null;
  buttonColor: string | null;
  buttonTextColor: string | null;
  buttonHoverColor: string | null;
  linkColor: string | null;
  linkHoverColor: string | null;
  inputFocusColor: string | null;
  companySlogan: string | null;
  companyWelcomeText: string | null;
  dashboardGreetingText: string | null;
  customTerminology: Record<string, unknown>;
  invitationTemplate: string | null;
  onboardingWording: Record<string, unknown>;
  customCss: Record<string, unknown>;
  isActive: boolean;
  customDomain: string | null;
  subdomain: string | null;
  dnsTarget: string | null;
  domainError: string | null;
}>;

export type DomainRecord = {
  id: string;
  organizationId: string;
  domain: string;
  domainType: 'subdomain' | 'custom_domain';
  status: string;
  cnameHost: string;
  cnameTarget: string;
  txtHost: string;
  txtValue: string;
  verifiedAt: Date | null;
  connectedAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  sslStatus: string;
  provider: string;
  providerDomainId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type HostOrganizationRecord = {
  id: string;
  name: string;
  slug: string;
  status: string | null;
  accessStatus: string | null;
  isActive: boolean | null;
  isSystemOrganization: boolean | null;
  domain: string | null;
  domainStatus: string | null;
};

type BrandingRow = {
  organization_id: string;
  brand_name: string | null;
  app_name: string | null;
  logo_url: string | null;
  logo_object_key: string | null;
  favicon_url: string | null;
  favicon_object_key: string | null;
  login_background_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  background_color: string | null;
  card_color: string | null;
  sidebar_color: string | null;
  topbar_color: string | null;
  text_color: string | null;
  muted_text_color: string | null;
  border_color: string | null;
  button_color: string | null;
  button_text_color: string | null;
  button_hover_color: string | null;
  link_color: string | null;
  link_hover_color: string | null;
  input_focus_color: string | null;
  company_slogan: string | null;
  company_welcome_text: string | null;
  dashboard_greeting_text: string | null;
  custom_terminology: Record<string, unknown> | null;
  invitation_template: string | null;
  onboarding_wording: Record<string, unknown> | null;
  custom_css: Record<string, unknown> | null;
  is_active: boolean;
  custom_domain: string | null;
  subdomain: string | null;
  dns_target: string | null;
  domain_error: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  organization_status: string | null;
  organization_access_status: string | null;
  organization_is_active: boolean | null;
  created_at: Date;
  updated_at: Date;
};

type DomainRow = {
  id: string;
  organization_id: string;
  domain: string;
  domain_type: 'subdomain' | 'custom_domain';
  status: string;
  cname_host: string;
  cname_target: string;
  txt_host: string;
  txt_value: string;
  verified_at: Date | null;
  connected_at: Date | null;
  last_checked_at: Date | null;
  last_error: string | null;
  ssl_status: string;
  provider: string;
  provider_domain_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type HostOrgRow = {
  id: string;
  name: string;
  slug: string;
  status: string | null;
  access_status: string | null;
  is_active: boolean | null;
  is_system_organization: boolean | null;
  domain: string | null;
  domain_status: string | null;
};

const BRANDING_SELECT = `
  b.organization_id,
  b.brand_name,
  b.app_name,
  b.logo_url,
  b.logo_object_key,
  b.favicon_url,
  b.favicon_object_key,
  b.login_background_url,
  b.primary_color,
  b.secondary_color,
  b.accent_color,
  b.background_color,
  b.card_color,
  b.sidebar_color,
  b.topbar_color,
  b.text_color,
  b.muted_text_color,
  b.border_color,
  b.button_color,
  b.button_text_color,
  b.button_hover_color,
  b.link_color,
  b.link_hover_color,
  b.input_focus_color,
  b.company_slogan,
  b.company_welcome_text,
  b.dashboard_greeting_text,
  b.custom_terminology,
  b.invitation_template,
  b.onboarding_wording,
  b.custom_css,
  b.is_active,
  o.custom_domain,
  o.subdomain,
  b.dns_target,
  b.domain_error,
  o.name AS organization_name,
  o.slug AS organization_slug,
  o.status AS organization_status,
  o.access_status AS organization_access_status,
  o.is_active AS organization_is_active,
  b.created_at,
  b.updated_at
`;

function serializeBranding(row: BrandingRow): BrandingRecord {
  return {
    organizationId: row.organization_id,
    brandName: row.brand_name,
    appName: row.app_name,
    logoUrl: row.logo_url,
    logoObjectKey: row.logo_object_key,
    faviconUrl: row.favicon_url,
    faviconObjectKey: row.favicon_object_key,
    loginBackgroundUrl: row.login_background_url,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    accentColor: row.accent_color,
    backgroundColor: row.background_color,
    cardColor: row.card_color,
    sidebarColor: row.sidebar_color,
    topbarColor: row.topbar_color,
    textColor: row.text_color,
    mutedTextColor: row.muted_text_color,
    borderColor: row.border_color,
    buttonColor: row.button_color,
    buttonTextColor: row.button_text_color,
    buttonHoverColor: row.button_hover_color,
    linkColor: row.link_color,
    linkHoverColor: row.link_hover_color,
    inputFocusColor: row.input_focus_color,
    companySlogan: row.company_slogan,
    companyWelcomeText: row.company_welcome_text,
    dashboardGreetingText: row.dashboard_greeting_text,
    customTerminology: row.custom_terminology ?? {},
    invitationTemplate: row.invitation_template,
    onboardingWording: row.onboarding_wording ?? {},
    customCss: row.custom_css ?? {},
    isActive: row.is_active,
    customDomain: row.custom_domain,
    subdomain: row.subdomain,
    dnsTarget: row.dns_target,
    domainError: row.domain_error,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    organizationStatus: row.organization_status,
    organizationAccessStatus: row.organization_access_status,
    organizationIsActive: row.organization_is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeDomain(row: DomainRow): DomainRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    domain: row.domain,
    domainType: row.domain_type,
    status: row.status,
    cnameHost: row.cname_host,
    cnameTarget: row.cname_target,
    txtHost: row.txt_host,
    txtValue: row.txt_value,
    verifiedAt: row.verified_at,
    connectedAt: row.connected_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    sslStatus: row.ssl_status,
    provider: row.provider,
    providerDomainId: row.provider_domain_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeHost(host: string) {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

export class PostgresBrandingStore {
  async ensureBranding(organizationId: string): Promise<BrandingRecord> {
    const existing = await this.getBranding(organizationId);
    if (existing) return existing;

    const org = await db.query<{ name: string; logo_url: string | null; primary_color: string | null; secondary_color: string | null }>(
      `
        SELECT name, logo_url, primary_color, secondary_color
        FROM organizations.organizations
        WHERE id = $1
      `,
      [organizationId],
    );
    if (!org.rows[0]) {
      throw new NotFoundError('ORGANIZATION_NOT_FOUND', 'The organization was not found.');
    }

    await db.query(
      `
        INSERT INTO organizations.branding (
          organization_id, brand_name, app_name, logo_url, primary_color, secondary_color
        )
        VALUES ($1, $2, $2, $3, COALESCE($4, '#000000'), COALESCE($5, '#ffffff'))
        ON CONFLICT (organization_id) DO NOTHING
      `,
      [
        organizationId,
        org.rows[0].name,
        org.rows[0].logo_url,
        org.rows[0].primary_color,
        org.rows[0].secondary_color,
      ],
    );

    const created = await this.getBranding(organizationId);
    if (!created) {
      throw new NotFoundError('BRANDING_NOT_FOUND', 'Organization branding was not found.');
    }
    return created;
  }

  async getBranding(organizationId: string): Promise<BrandingRecord | null> {
    const result = await db.query<BrandingRow>(
      `
        SELECT ${BRANDING_SELECT}
        FROM organizations.branding b
        JOIN organizations.organizations o ON o.id = b.organization_id
        WHERE b.organization_id = $1
      `,
      [organizationId],
    );
    return result.rows[0] ? serializeBranding(result.rows[0]) : null;
  }

  async updateBranding(
    organizationId: string,
    patch: BrandingPatch,
  ): Promise<BrandingRecord> {
    await this.ensureBranding(organizationId);

    const assignments: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let index = 1;

    const map: Array<[keyof BrandingPatch, string]> = [
      ['brandName', 'brand_name'],
      ['appName', 'app_name'],
      ['logoUrl', 'logo_url'],
      ['logoObjectKey', 'logo_object_key'],
      ['faviconUrl', 'favicon_url'],
      ['faviconObjectKey', 'favicon_object_key'],
      ['loginBackgroundUrl', 'login_background_url'],
      ['primaryColor', 'primary_color'],
      ['secondaryColor', 'secondary_color'],
      ['accentColor', 'accent_color'],
      ['backgroundColor', 'background_color'],
      ['cardColor', 'card_color'],
      ['sidebarColor', 'sidebar_color'],
      ['topbarColor', 'topbar_color'],
      ['textColor', 'text_color'],
      ['mutedTextColor', 'muted_text_color'],
      ['borderColor', 'border_color'],
      ['buttonColor', 'button_color'],
      ['buttonTextColor', 'button_text_color'],
      ['buttonHoverColor', 'button_hover_color'],
      ['linkColor', 'link_color'],
      ['linkHoverColor', 'link_hover_color'],
      ['inputFocusColor', 'input_focus_color'],
      ['companySlogan', 'company_slogan'],
      ['companyWelcomeText', 'company_welcome_text'],
      ['dashboardGreetingText', 'dashboard_greeting_text'],
      ['customTerminology', 'custom_terminology'],
      ['invitationTemplate', 'invitation_template'],
      ['onboardingWording', 'onboarding_wording'],
      ['customCss', 'custom_css'],
      ['isActive', 'is_active'],
      ['dnsTarget', 'dns_target'],
      ['domainError', 'domain_error'],
    ];

    for (const [key, column] of map) {
      if (patch[key] !== undefined) {
        assignments.push(`${column} = $${index++}`);
        values.push(patch[key]);
      }
    }

    values.push(organizationId);
    await db.query(
      `
        UPDATE organizations.branding
        SET ${assignments.join(', ')}
        WHERE organization_id = $${index}
      `,
      values,
    );

    const orgAssignments: string[] = ['updated_at = NOW()'];
    const orgValues: unknown[] = [];
    let orgIndex = 1;
    if (patch.logoUrl !== undefined) {
      orgAssignments.push(`logo_url = $${orgIndex++}`);
      orgValues.push(patch.logoUrl);
    }
    if (patch.primaryColor !== undefined) {
      orgAssignments.push(`primary_color = $${orgIndex++}`);
      orgValues.push(patch.primaryColor);
    }
    if (patch.secondaryColor !== undefined) {
      orgAssignments.push(`secondary_color = $${orgIndex++}`);
      orgValues.push(patch.secondaryColor);
    }
    if (patch.customDomain !== undefined) {
      orgAssignments.push(`custom_domain = $${orgIndex++}`);
      orgValues.push(patch.customDomain);
    }
    if (patch.subdomain !== undefined) {
      orgAssignments.push(`subdomain = $${orgIndex++}`);
      orgValues.push(patch.subdomain);
    }
    if (orgValues.length > 0) {
      orgValues.push(organizationId);
      await db.query(
        `
          UPDATE organizations.organizations
          SET ${orgAssignments.join(', ')}
          WHERE id = $${orgIndex}
        `,
        orgValues,
      );
    }

    const updated = await this.getBranding(organizationId);
    if (!updated) {
      throw new NotFoundError('BRANDING_NOT_FOUND', 'Organization branding was not found.');
    }
    return updated;
  }

  async resolveOrganizationByHost(hostName: string): Promise<HostOrganizationRecord | null> {
    const host = normalizeHost(hostName);
    if (!host) return null;

    const subdomain =
      host.endsWith('.itsnomatata.com')
        ? host.replace(/\.itsnomatata\.com$/, '')
        : null;

    const result = await db.query<HostOrgRow>(
      `
        SELECT
          o.id,
          o.name,
          o.slug,
          o.status,
          o.access_status,
          o.is_active,
          o.is_system_organization,
          COALESCE(d.domain, o.custom_domain, o.subdomain) AS domain,
          d.status AS domain_status
        FROM organizations.organizations o
        LEFT JOIN organizations.domains d
          ON d.organization_id = o.id
         AND lower(d.domain) = lower($1)
        WHERE o.is_active = TRUE
          AND (
            lower(o.custom_domain) = lower($1)
            OR lower(o.subdomain) = lower($2)
            OR lower(o.subdomain) = lower($1)
            OR EXISTS (
              SELECT 1
              FROM organizations.domains od
              WHERE od.organization_id = o.id
                AND lower(od.domain) = lower($1)
                AND od.status IN ('verified', 'connected', 'dns_pending', 'pending')
            )
          )
        ORDER BY
          CASE WHEN lower(o.custom_domain) = lower($1) THEN 0 ELSE 1 END,
          o.created_at ASC
        LIMIT 1
      `,
      [host, subdomain ?? host],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      accessStatus: row.access_status,
      isActive: row.is_active,
      isSystemOrganization: row.is_system_organization,
      domain: row.domain,
      domainStatus: row.domain_status,
    };
  }

  async getBrandingByHost(hostName: string): Promise<BrandingRecord | null> {
    const org = await this.resolveOrganizationByHost(hostName);
    if (!org) return null;
    return this.ensureBranding(org.id);
  }

  async listDomains(organizationId: string): Promise<DomainRecord[]> {
    const result = await db.query<DomainRow>(
      `
        SELECT *
        FROM organizations.domains
        WHERE organization_id = $1
        ORDER BY created_at DESC
      `,
      [organizationId],
    );
    return result.rows.map(serializeDomain);
  }

  async createDomain(input: {
    organizationId: string;
    domain: string;
    createdBy: string;
  }): Promise<DomainRecord> {
    const domain = normalizeHost(input.domain);
    if (!domain) {
      throw new ValidationError('Domain is required.', { field: 'domain' });
    }
    const domainType = domain.includes('.') && !domain.endsWith('.itsnomatata.com')
      ? 'custom_domain'
      : 'subdomain';
    const txtValue = `kode-verify=${randomUUID()}`;

    const result = await db.query<DomainRow>(
      `
        INSERT INTO organizations.domains (
          organization_id, domain, domain_type, status,
          cname_host, cname_target, txt_host, txt_value, created_by
        )
        VALUES ($1, $2, $3, 'pending', 'www', 'cname.vercel-dns.com', '_kode-verify', $4, $5)
        RETURNING *
      `,
      [input.organizationId, domain, domainType, txtValue, input.createdBy],
    );

    if (domainType === 'custom_domain') {
      await db.query(
        `
          UPDATE organizations.organizations
          SET custom_domain = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [input.organizationId, domain],
      );
    } else {
      const subdomain = domain.replace(/\.itsnomatata\.com$/, '');
      await db.query(
        `
          UPDATE organizations.organizations
          SET subdomain = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [input.organizationId, subdomain],
      );
    }

    return serializeDomain(result.rows[0]);
  }

  async getDomain(
    organizationId: string,
    domainId: string,
  ): Promise<DomainRecord | null> {
    const result = await db.query<DomainRow>(
      `
        SELECT *
        FROM organizations.domains
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, domainId],
    );
    return result.rows[0] ? serializeDomain(result.rows[0]) : null;
  }

  async stubVerifyDomain(
    organizationId: string,
    domainId: string,
  ): Promise<DomainRecord> {
    const result = await db.query<DomainRow>(
      `
        UPDATE organizations.domains
        SET
          status = 'verified',
          verified_at = NOW(),
          last_checked_at = NOW(),
          last_error = NULL,
          updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
        RETURNING *
      `,
      [organizationId, domainId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('DOMAIN_NOT_FOUND', 'Domain was not found.');
    }
    return serializeDomain(result.rows[0]);
  }

  async stubConnectDomain(
    organizationId: string,
    domainId: string,
  ): Promise<DomainRecord> {
    const result = await db.query<DomainRow>(
      `
        UPDATE organizations.domains
        SET
          status = 'connected',
          connected_at = NOW(),
          last_checked_at = NOW(),
          ssl_status = 'active',
          last_error = NULL,
          updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
        RETURNING *
      `,
      [organizationId, domainId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('DOMAIN_NOT_FOUND', 'Domain was not found.');
    }
    return serializeDomain(result.rows[0]);
  }

  async deleteDomain(organizationId: string, domainId: string): Promise<void> {
    const existing = await this.getDomain(organizationId, domainId);
    if (!existing) {
      throw new NotFoundError('DOMAIN_NOT_FOUND', 'Domain was not found.');
    }
    await db.query(
      `
        DELETE FROM organizations.domains
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, domainId],
    );
  }
}
