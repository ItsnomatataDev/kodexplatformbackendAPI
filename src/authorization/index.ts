export { authorize, assertAuthorized } from './authorize.js';
export { hasPermission } from './permissions.js';
export {
  assertSameOrganization,
  rejectClientOrganizationOverride,
  requireOrganizationId,
} from './organization.js';
export type {
  Actor,
  AuthContext,
  AuthorizationDecision,
  AuthorizeInput,
  OrganizationMembership,
  ProtectedResource,
} from './types.js';
