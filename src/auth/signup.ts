import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { pickDirectoryRoleKey } from '../organizations/role-model.js';
import type { OrganizationDirectoryStore, OrganizationRecord } from '../organizations/store.js';
import { hashPassword, validatePassword } from './passwords.js';
import { normalizeEmail } from './login.js';

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export type SignupServiceConfig = {
  store: OrganizationDirectoryStore;
  resolveByHost?: (host: string) => Promise<OrganizationRecord | null>;
};

export type SignupOptionsQuery = {
  organizationId?: string;
  organizationSlug?: string;
  host?: string;
};

export type SignupInput = {
  email: string;
  password: string;
  fullName: string;
  roleKey?: string;
  organizationId?: string;
  organizationSlug?: string;
  officeId?: string;
  officeSlug?: string;
  host?: string;
};

function requireActiveOrganization(record: OrganizationRecord | null): OrganizationRecord {
  if (!record || !record.isActive || record.status !== 'active' || record.accessStatus !== 'active') {
    throw new NotFoundError(
      'ORGANIZATION_NOT_FOUND',
      'Organization was not found or does not allow signup.',
    );
  }
  return record;
}

export class SignupService {
  constructor(private readonly config: SignupServiceConfig) {}

  async resolveOrganization(query: SignupOptionsQuery): Promise<OrganizationRecord | null> {
    if (query.organizationId) {
      return this.config.store.getOrganization(query.organizationId);
    }
    if (query.organizationSlug) {
      return this.config.store.getOrganizationBySlug(query.organizationSlug);
    }
    if (query.host && this.config.resolveByHost) {
      return this.config.resolveByHost(query.host);
    }
    return null;
  }

  async options(query: SignupOptionsQuery) {
    const organization = requireActiveOrganization(await this.resolveOrganization(query));
    const [roles, offices] = await Promise.all([
      this.config.store.listOperatingRoles(organization.id),
      this.config.store.listOffices(organization.id),
    ]);
    const publicRoles = roles.filter((role) => !role.isAdminRole);
    return {
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
      roles: publicRoles.map((role) => ({
        roleKey: role.roleKey,
        roleLabel: role.roleLabel,
        isDefaultSignupRole: Boolean(role.isDefaultSignupRole),
      })),
      offices: offices
        .filter((office) => office.isActive)
        .map((office) => ({
          id: office.id,
          name: office.name,
          slug: office.slug,
          isPrimary: office.isPrimary,
        })),
    };
  }

  async signup(input: SignupInput) {
    const email = normalizeEmail(input.email);
    if (!email || !EMAIL_PATTERN.test(email) || /[\x00-\x1f\x7f]/.test(email)) {
      throw new ValidationError('Enter a valid email address.', { field: 'email' });
    }
    const fullName = input.fullName.trim();
    if (!fullName) {
      throw new ValidationError('Full name is required.', { field: 'fullName' });
    }
    if (fullName.length > 200) {
      throw new ValidationError('Full name is too long.', { field: 'fullName' });
    }
    validatePassword(input.password, email);

    const organization = requireActiveOrganization(
      await this.resolveOrganization({
        organizationId: input.organizationId,
        organizationSlug: input.organizationSlug,
        host: input.host,
      }),
    );

    const roles = await this.config.store.listOperatingRoles(organization.id);
    const roleKey = pickDirectoryRoleKey(roles, input.roleKey, { allowAdmin: false });
    if (!roleKey) {
      throw new ValidationError('The selected role is not available.', { field: 'roleKey' });
    }

    let officeId = input.officeId ?? null;
    if (!officeId && input.officeSlug) {
      const offices = await this.config.store.listOffices(organization.id);
      const match = offices.find(
        (office) => office.isActive && office.slug === input.officeSlug,
      );
      officeId = match?.id ?? null;
    }

    const existing = await this.config.store.findUserByEmail(email);
    if (existing) {
      throw new ConflictError(
        'ACCOUNT_EXISTS',
        'An account with this email already exists. Sign in or ask an administrator to invite you.',
      );
    }

    const created = await this.config.store.createSelfSignup({
      organizationId: organization.id,
      email,
      fullName,
      roleKey,
      officeId,
      passwordHash: await hashPassword(input.password),
    });

    return {
      user: { id: created.userId, email: created.email },
      organization: {
        id: created.organizationId,
        name: organization.name,
        slug: organization.slug,
      },
      membership: {
        id: created.membershipId,
        roleKey: created.roleKey,
        status: 'pending',
      },
      approvalRequired: true,
      message: 'Account created. An administrator must approve it before you can sign in.',
    };
  }
}
