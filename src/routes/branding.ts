import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { hasPermission } from '../authorization/permissions.js';
import { requireOrganizationId } from '../authorization/organization.js';
import type { AuthContext } from '../authorization/types.js';
import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../http/errors.js';
import { streamStoredMedia } from '../content/media-stream.js';
import type { FileStorage } from '../files/storage.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import {
  ORGANIZATION_BRANDING_BUCKET,
  organizationBrandingObjectKey,
} from '../organizations/buckets.js';
import type { PostgresBrandingStore } from '../organizations/branding-store.js';
import type { BrandingRecord } from '../organizations/branding-store.js';

export type BrandingRouteDependencies = {
  store: PostgresBrandingStore;
  files: FileStorage;
};

const MAX_BRANDING_UPLOAD_BYTES = 8 * 1024 * 1024;

function canManageBranding(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it' ||
    hasPermission(auth.membership.permissions, 'organization.branding_manage')
  );
}

function canManageDomains(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it' ||
    hasPermission(auth.membership.permissions, 'organization.domains_manage')
  );
}

function serializeBranding(row: BrandingRecord) {
  return {
    id: row.organizationId,
    organization_id: row.organizationId,
    brand_name: row.brandName ?? row.organizationName,
    app_name: row.appName ?? row.brandName ?? row.organizationName,
    logo_url: row.logoUrl,
    logo_object_key: row.logoObjectKey,
    favicon_url: row.faviconUrl,
    favicon_object_key: row.faviconObjectKey,
    login_background_url: row.loginBackgroundUrl,
    primary_color: row.primaryColor,
    secondary_color: row.secondaryColor,
    accent_color: row.accentColor,
    background_color: row.backgroundColor,
    card_color: row.cardColor,
    sidebar_color: row.sidebarColor,
    topbar_color: row.topbarColor,
    text_color: row.textColor,
    muted_text_color: row.mutedTextColor,
    border_color: row.borderColor,
    button_color: row.buttonColor,
    button_text_color: row.buttonTextColor,
    button_hover_color: row.buttonHoverColor,
    link_color: row.linkColor,
    link_hover_color: row.linkHoverColor,
    input_focus_color: row.inputFocusColor,
    company_slogan: row.companySlogan,
    company_welcome_text: row.companyWelcomeText,
    dashboard_greeting_text: row.dashboardGreetingText,
    custom_terminology: row.customTerminology,
    invitation_template: row.invitationTemplate,
    onboarding_wording: row.onboardingWording,
    custom_css: row.customCss,
    is_active: row.isActive,
    custom_domain: row.customDomain,
    subdomain: row.subdomain,
    domain_status: null,
    domain_verification_token: null,
    dns_target: row.dnsTarget,
    domain_error: row.domainError,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function requireBinaryUploadSize(c: {
  req: { header: (name: string) => string | undefined };
}) {
  const raw = c.req.header('content-length');
  if (!raw) {
    throw new ValidationError('Content-Length is required for binary uploads.', {
      field: 'Content-Length',
    });
  }
  const size = Number.parseInt(raw, 10);
  if (!Number.isFinite(size) || size < 1) {
    throw new ValidationError('Content-Length must be a positive number.', {
      field: 'Content-Length',
    });
  }
  if (size > MAX_BRANDING_UPLOAD_BYTES) {
    throw new PayloadTooLargeError();
  }
  return size;
}

async function putBinary(
  files: FileStorage,
  input: {
    objectKey: string;
    body: ReadableStream<Uint8Array>;
    contentType: string;
    contentLength: number;
  },
) {
  await files.ensureBucket?.(ORGANIZATION_BRANDING_BUCKET);
  const put =
    files.putObjectStream?.bind(files) ??
    (async (streamInput: {
      bucket: string;
      objectKey: string;
      body: ReadableStream<Uint8Array> | Buffer;
      contentType?: string | null;
      contentLength: number;
    }) => {
      const chunks: Uint8Array[] = [];
      const reader = (streamInput.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      await files.putObject({
        bucket: streamInput.bucket,
        objectKey: streamInput.objectKey,
        body: Buffer.concat(chunks.map((c) => Buffer.from(c))),
        contentType: streamInput.contentType,
      });
    });

  await put({
    bucket: ORGANIZATION_BRANDING_BUCKET,
    objectKey: input.objectKey,
    body: input.body,
    contentType: input.contentType,
    contentLength: input.contentLength,
  });
}

/** Public (unauthenticated) host resolution + branding-by-host. */
export function createPublicBrandingRoutes(
  dependencies: Pick<BrandingRouteDependencies, 'store'>,
) {
  const routes = new Hono();

  routes.get('/resolve-by-host', async (c) => {
    const host = (c.req.query('host') ?? '').trim().toLowerCase();
    if (!host) {
      throw new ValidationError('host is required.', { field: 'host' });
    }
    const organization = await dependencies.store.resolveOrganizationByHost(host);
    return c.json({
      organization: organization
        ? {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            status: organization.status,
            access_status: organization.accessStatus,
            is_active: organization.isActive,
            is_system_organization: organization.isSystemOrganization,
            domain: organization.domain,
            domain_status: organization.domainStatus,
          }
        : null,
    });
  });

  routes.get('/branding/by-host', async (c) => {
    const host = (c.req.query('host') ?? '').trim().toLowerCase();
    if (!host) {
      throw new ValidationError('host is required.', { field: 'host' });
    }
    const branding = await dependencies.store.getBrandingByHost(host);
    return c.json({
      branding: branding ? serializeBranding(branding) : null,
    });
  });

  return routes;
}

export function createBrandingRoutes(dependencies: BrandingRouteDependencies) {
  const routes = new Hono();

  routes.get('/branding', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    assertAuthorized({
      context: auth,
      action: 'organization.branding_read',
      resource: { type: 'organization', organizationId },
    });
    const branding = await dependencies.store.ensureBranding(organizationId);
    return c.json({ branding: serializeBranding(branding) });
  });

  routes.patch('/branding', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    assertAuthorized({
      context: auth,
      action: 'organization.branding_manage',
      resource: { type: 'organization', organizationId },
    });
    if (!canManageBranding(auth)) {
      throw new ForbiddenError(
        'BRANDING_ADMIN_REQUIRED',
        'Only administrators, managers, and IT can update branding.',
      );
    }

    const body = await readJson(c);
    const branding = await dependencies.store.updateBranding(organizationId, {
      brandName: body.brandName !== undefined || body.brand_name !== undefined
        ? readOptionalString(body.brandName ?? body.brand_name, 'brandName', 200) ?? null
        : undefined,
      appName: body.appName !== undefined || body.app_name !== undefined
        ? readOptionalString(body.appName ?? body.app_name, 'appName', 200) ?? null
        : undefined,
      logoUrl: body.logoUrl !== undefined || body.logo_url !== undefined
        ? readOptionalString(body.logoUrl ?? body.logo_url, 'logoUrl', 2000) ?? null
        : undefined,
      logoObjectKey:
        body.logoObjectKey !== undefined || body.logo_object_key !== undefined
          ? readOptionalString(
              body.logoObjectKey ?? body.logo_object_key,
              'logoObjectKey',
              1000,
            ) ?? null
          : undefined,
      faviconUrl:
        body.faviconUrl !== undefined || body.favicon_url !== undefined
          ? readOptionalString(body.faviconUrl ?? body.favicon_url, 'faviconUrl', 2000) ??
            null
          : undefined,
      faviconObjectKey:
        body.faviconObjectKey !== undefined || body.favicon_object_key !== undefined
          ? readOptionalString(
              body.faviconObjectKey ?? body.favicon_object_key,
              'faviconObjectKey',
              1000,
            ) ?? null
          : undefined,
      loginBackgroundUrl:
        body.loginBackgroundUrl !== undefined ||
        body.login_background_url !== undefined
          ? readOptionalString(
              body.loginBackgroundUrl ?? body.login_background_url,
              'loginBackgroundUrl',
              2000,
            ) ?? null
          : undefined,
      primaryColor:
        body.primaryColor !== undefined || body.primary_color !== undefined
          ? readOptionalString(body.primaryColor ?? body.primary_color, 'primaryColor', 32) ??
            null
          : undefined,
      secondaryColor:
        body.secondaryColor !== undefined || body.secondary_color !== undefined
          ? readOptionalString(
              body.secondaryColor ?? body.secondary_color,
              'secondaryColor',
              32,
            ) ?? null
          : undefined,
      accentColor:
        body.accentColor !== undefined || body.accent_color !== undefined
          ? readOptionalString(body.accentColor ?? body.accent_color, 'accentColor', 32) ??
            null
          : undefined,
      backgroundColor:
        body.backgroundColor !== undefined || body.background_color !== undefined
          ? readOptionalString(
              body.backgroundColor ?? body.background_color,
              'backgroundColor',
              32,
            ) ?? null
          : undefined,
      cardColor:
        body.cardColor !== undefined || body.card_color !== undefined
          ? readOptionalString(body.cardColor ?? body.card_color, 'cardColor', 32) ?? null
          : undefined,
      sidebarColor:
        body.sidebarColor !== undefined || body.sidebar_color !== undefined
          ? readOptionalString(body.sidebarColor ?? body.sidebar_color, 'sidebarColor', 32) ??
            null
          : undefined,
      topbarColor:
        body.topbarColor !== undefined || body.topbar_color !== undefined
          ? readOptionalString(body.topbarColor ?? body.topbar_color, 'topbarColor', 32) ??
            null
          : undefined,
      textColor:
        body.textColor !== undefined || body.text_color !== undefined
          ? readOptionalString(body.textColor ?? body.text_color, 'textColor', 32) ?? null
          : undefined,
      mutedTextColor:
        body.mutedTextColor !== undefined || body.muted_text_color !== undefined
          ? readOptionalString(
              body.mutedTextColor ?? body.muted_text_color,
              'mutedTextColor',
              32,
            ) ?? null
          : undefined,
      borderColor:
        body.borderColor !== undefined || body.border_color !== undefined
          ? readOptionalString(body.borderColor ?? body.border_color, 'borderColor', 32) ??
            null
          : undefined,
      buttonColor:
        body.buttonColor !== undefined || body.button_color !== undefined
          ? readOptionalString(body.buttonColor ?? body.button_color, 'buttonColor', 32) ??
            null
          : undefined,
      buttonTextColor:
        body.buttonTextColor !== undefined || body.button_text_color !== undefined
          ? readOptionalString(
              body.buttonTextColor ?? body.button_text_color,
              'buttonTextColor',
              32,
            ) ?? null
          : undefined,
      buttonHoverColor:
        body.buttonHoverColor !== undefined || body.button_hover_color !== undefined
          ? readOptionalString(
              body.buttonHoverColor ?? body.button_hover_color,
              'buttonHoverColor',
              32,
            ) ?? null
          : undefined,
      linkColor:
        body.linkColor !== undefined || body.link_color !== undefined
          ? readOptionalString(body.linkColor ?? body.link_color, 'linkColor', 32) ?? null
          : undefined,
      linkHoverColor:
        body.linkHoverColor !== undefined || body.link_hover_color !== undefined
          ? readOptionalString(
              body.linkHoverColor ?? body.link_hover_color,
              'linkHoverColor',
              32,
            ) ?? null
          : undefined,
      inputFocusColor:
        body.inputFocusColor !== undefined || body.input_focus_color !== undefined
          ? readOptionalString(
              body.inputFocusColor ?? body.input_focus_color,
              'inputFocusColor',
              32,
            ) ?? null
          : undefined,
      companySlogan:
        body.companySlogan !== undefined || body.company_slogan !== undefined
          ? readOptionalString(
              body.companySlogan ?? body.company_slogan,
              'companySlogan',
              500,
            ) ?? null
          : undefined,
      companyWelcomeText:
        body.companyWelcomeText !== undefined ||
        body.company_welcome_text !== undefined
          ? readOptionalString(
              body.companyWelcomeText ?? body.company_welcome_text,
              'companyWelcomeText',
              2000,
            ) ?? null
          : undefined,
      dashboardGreetingText:
        body.dashboardGreetingText !== undefined ||
        body.dashboard_greeting_text !== undefined
          ? readOptionalString(
              body.dashboardGreetingText ?? body.dashboard_greeting_text,
              'dashboardGreetingText',
              2000,
            ) ?? null
          : undefined,
      invitationTemplate:
        body.invitationTemplate !== undefined ||
        body.invitation_template !== undefined
          ? readOptionalString(
              body.invitationTemplate ?? body.invitation_template,
              'invitationTemplate',
              5000,
            ) ?? null
          : undefined,
      customTerminology:
        body.customTerminology !== undefined || body.custom_terminology !== undefined
          ? ((body.customTerminology ?? body.custom_terminology) as Record<
              string,
              unknown
            >)
          : undefined,
      onboardingWording:
        body.onboardingWording !== undefined || body.onboarding_wording !== undefined
          ? ((body.onboardingWording ?? body.onboarding_wording) as Record<
              string,
              unknown
            >)
          : undefined,
      customCss:
        body.customCss !== undefined || body.custom_css !== undefined
          ? ((body.customCss ?? body.custom_css) as Record<string, unknown>)
          : undefined,
      customDomain:
        body.customDomain !== undefined || body.custom_domain !== undefined
          ? readOptionalString(
              body.customDomain ?? body.custom_domain,
              'customDomain',
              255,
            ) ?? null
          : undefined,
      subdomain:
        body.subdomain !== undefined
          ? readOptionalString(body.subdomain, 'subdomain', 120) ?? null
          : undefined,
      dnsTarget:
        body.dnsTarget !== undefined || body.dns_target !== undefined
          ? readOptionalString(body.dnsTarget ?? body.dns_target, 'dnsTarget', 255) ??
            null
          : undefined,
    });

    return c.json({ branding: serializeBranding(branding) });
  });

  routes.post('/branding/assets/binary', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    assertAuthorized({
      context: auth,
      action: 'organization.branding_manage',
      resource: { type: 'organization', organizationId },
    });
    if (!canManageBranding(auth)) {
      throw new ForbiddenError(
        'BRANDING_ADMIN_REQUIRED',
        'Only administrators, managers, and IT can upload branding assets.',
      );
    }

    const kindRaw = (c.req.query('kind') ?? 'logo').toLowerCase();
    const kind =
      kindRaw === 'favicon'
        ? 'favicon'
        : kindRaw === 'login_background'
          ? 'login_background'
          : 'logo';
    const sizeBytes = requireBinaryUploadSize(c);
    const filename =
      decodeURIComponent(
        c.req.query('filename') ?? c.req.header('x-kode-filename') ?? 'asset.bin',
      );
    const contentType =
      readOptionalString(
        c.req.header('content-type') ?? c.req.header('x-kode-content-type'),
        'contentType',
        200,
      ) ?? 'application/octet-stream';
    if (!c.req.raw.body) {
      throw new ValidationError('Request body is required.', { field: 'body' });
    }

    const objectKey = organizationBrandingObjectKey({
      organizationId,
      kind,
      filename,
    });
    await putBinary(dependencies.files, {
      objectKey,
      body: c.req.raw.body,
      contentType,
      contentLength: sizeBytes,
    });

    const assetPath = `/api/organization/branding/assets?objectKey=${encodeURIComponent(objectKey)}`;
    const patch =
      kind === 'favicon'
        ? { faviconUrl: assetPath, faviconObjectKey: objectKey }
        : kind === 'login_background'
          ? { loginBackgroundUrl: assetPath }
          : { logoUrl: assetPath, logoObjectKey: objectKey };

    const branding = await dependencies.store.updateBranding(organizationId, patch);
    return c.json(
      {
        ok: true,
        kind,
        objectKey,
        publicUrl: assetPath,
        branding: serializeBranding(branding),
      },
      201,
    );
  });

  routes.get('/branding/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    assertAuthorized({
      context: auth,
      action: 'organization.branding_read',
      resource: { type: 'organization', organizationId },
    });
    const objectKey = c.req.query('objectKey');
    if (!objectKey || !objectKey.startsWith(`${organizationId}/`)) {
      throw new ValidationError('objectKey is invalid.', { field: 'objectKey' });
    }
    return streamStoredMedia({
      files: dependencies.files,
      bucket: ORGANIZATION_BRANDING_BUCKET,
      objectKey,
      rangeHeader: c.req.header('range'),
      cacheControl: 'private, max-age=3600',
      notFoundCode: 'ASSET_NOT_FOUND',
      notFoundMessage: 'Branding asset was not found.',
    });
  });

  routes.get('/domains', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    if (!canManageDomains(auth)) {
      throw new ForbiddenError(
        'DOMAIN_ADMIN_REQUIRED',
        'Only administrators, managers, and IT can manage domains.',
      );
    }
    const domains = await dependencies.store.listDomains(organizationId);
    return c.json({
      ok: true,
      domains: domains.map((domain) => ({
        id: domain.id,
        organization_id: domain.organizationId,
        domain: domain.domain,
        domain_type: domain.domainType,
        status: domain.status,
        cname_host: domain.cnameHost,
        cname_fqdn: `${domain.cnameHost}.${domain.domain}`,
        cname_target: domain.cnameTarget,
        txt_host: domain.txtHost,
        txt_fqdn: `${domain.txtHost}.${domain.domain}`,
        txt_value: domain.txtValue,
        verified_at: domain.verifiedAt?.toISOString() ?? null,
        connected_at: domain.connectedAt?.toISOString() ?? null,
        last_checked_at: domain.lastCheckedAt?.toISOString() ?? null,
        last_error: domain.lastError,
        ssl_status: domain.sslStatus,
        provider: domain.provider,
        provider_domain_id: domain.providerDomainId,
        created_by: domain.createdBy,
        created_at: domain.createdAt.toISOString(),
        updated_at: domain.updatedAt.toISOString(),
      })),
    });
  });

  routes.post('/domains', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    if (!canManageDomains(auth)) {
      throw new ForbiddenError(
        'DOMAIN_ADMIN_REQUIRED',
        'Only administrators, managers, and IT can manage domains.',
      );
    }
    const body = await readJson(c);
    const domain = await dependencies.store.createDomain({
      organizationId,
      domain: readRequiredText(body.domain, 'domain', 255),
      createdBy: auth.actor.userId,
    });
    return c.json(
      {
        ok: true,
        domain: {
          id: domain.id,
          organization_id: domain.organizationId,
          domain: domain.domain,
          domain_type: domain.domainType,
          status: domain.status,
          cname_host: domain.cnameHost,
          cname_target: domain.cnameTarget,
          txt_host: domain.txtHost,
          txt_value: domain.txtValue,
          verified_at: null,
          connected_at: null,
          last_checked_at: null,
          last_error: null,
          ssl_status: domain.sslStatus,
          provider: domain.provider,
          provider_domain_id: null,
          created_by: domain.createdBy,
          created_at: domain.createdAt.toISOString(),
          updated_at: domain.updatedAt.toISOString(),
        },
      },
      201,
    );
  });

  routes.post('/domains/:domainId/verify', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    if (!canManageDomains(auth)) {
      throw new ForbiddenError(
        'DOMAIN_ADMIN_REQUIRED',
        'Only administrators, managers, and IT can manage domains.',
      );
    }
    const domainId = requireUuidValue(c.req.param('domainId'), 'domainId');
    const domain = await dependencies.store.stubVerifyDomain(
      organizationId,
      domainId,
    );
    return c.json({ ok: true, domain });
  });

  routes.post('/domains/:domainId/connect', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    if (!canManageDomains(auth)) {
      throw new ForbiddenError(
        'DOMAIN_ADMIN_REQUIRED',
        'Only administrators, managers, and IT can manage domains.',
      );
    }
    const domainId = requireUuidValue(c.req.param('domainId'), 'domainId');
    const domain = await dependencies.store.stubConnectDomain(
      organizationId,
      domainId,
    );
    return c.json({ ok: true, domain });
  });

  routes.post('/domains/:domainId/refresh', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    if (!canManageDomains(auth)) {
      throw new ForbiddenError(
        'DOMAIN_ADMIN_REQUIRED',
        'Only administrators, managers, and IT can manage domains.',
      );
    }
    const domainId = requireUuidValue(c.req.param('domainId'), 'domainId');
    const domain = await dependencies.store.getDomain(organizationId, domainId);
    if (!domain) {
      throw new NotFoundError('DOMAIN_NOT_FOUND', 'Domain was not found.');
    }
    return c.json({ ok: true, domain });
  });

  routes.delete('/domains/:domainId', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    if (!canManageDomains(auth)) {
      throw new ForbiddenError(
        'DOMAIN_ADMIN_REQUIRED',
        'Only administrators, managers, and IT can manage domains.',
      );
    }
    const domainId = requireUuidValue(c.req.param('domainId'), 'domainId');
    await dependencies.store.deleteDomain(organizationId, domainId);
    return c.json({ ok: true });
  });

  return routes;
}
