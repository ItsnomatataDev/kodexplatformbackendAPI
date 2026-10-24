# Employee invitation delivery

The Employees page in ITsNomatataWorkSpace calls
`POST /api/organization/members/invite` through the Kode directory client.
Previously this endpoint saved a pending user and membership without sending
email, and returned misleading signup instructions. Public self-serve signup is
`POST /auth/signup` and still requires administrator approval.

## Updated behavior

- Authorized directory managers can invite a new email address.
- The API saves a pending user and membership, then sends a branded invitation
  using the existing SMTP provider and password-token lifecycle.
- The single-use, expiring link opens
  `/reset-password?type=invite&token=...` on `APP_PUBLIC_URL`. Only a token hash is
  stored. No password is generated or emailed.
- Successful submission returns HTTP 201 with `status: invite_created`,
  `emailStatus: sent`, and an explanatory message. This means the SMTP provider
  accepted the message, not that inbox placement has been confirmed.
- Failed delivery returns HTTP 503, code `INVITATION_EMAIL_FAILED`. The pending
  account remains saved. Retry the same invitation to send another link.
  A failed send invalidates its new token while preserving an earlier usable
  link. A successful resend retires older links.
- Retrying a pending invitation does not activate the user or membership and
  does not change the originally assigned role. Use the approval/access flow
  to change access. Pending accounts in another organization cannot be linked
  through this retry path.
- Setting a password does not approve an account. An administrator must use the
  existing employee approval workflow. Existing active-account linking retains
  its existing behavior and does not send a setup email.
- Deleted accounts do not receive password-reset emails, and reset links issued
  before deletion cannot be used. A soft-deleted member remains available from
  `GET /api/organization/members?includeInactive=true` with
  `accountStatus: "deleted"`; the default members listing omits removed members.

The email escapes names and organization text, provides HTML and plain-text
versions, explains expiry, includes a fallback link, and asks recipients to
keep the link private. The setup page uses invitation wording when `type=invite`;
that parameter only changes presentation and grants no permissions.

## Release

No database migration is required. Review and deploy the API changes and the
frontend changes together. Preserve unrelated work in both repositories.

API files:

- `src/app.ts` (invitation dependency wiring only; this file also has unrelated local work)
- `src/routes/organization.ts`
- `src/organizations/postgres-store.ts`
- `src/organizations/memory-store.ts`
- `src/auth/defaults.ts`
- `src/auth/email.ts`
- `src/auth/password-service.ts`
- `src/email/branded-templates.ts`

Regression tests are in `tests/organization-directory.test.ts` and
`tests/email-delivery.test.ts`.

Frontend files in ITsNomatataWorkSpace:

- `src/features/admin/components/InviteUserModal.tsx`
- `src/features/auth/pages/ResetPasswordPage.tsx`

The VPS must have working `EMAIL_PROVIDER=smtp`, SMTP settings, and an
`APP_PUBLIC_URL` pointing to the deployed frontend. No live email or VPS
configuration was inspected or changed for this patch. After deployment, use
an authorized test recipient to verify actual receipt, setup, approval, and
sign-in. Check spam/provider delivery logs if SMTP accepts the email but it
does not arrive.

Validation: full API suite 358 passed, 10 skipped, 0 failed; API TypeScript check
and production build passed; frontend TypeScript/Vite production build passed
with dynamic-import warnings; email layout visually checked at 800px and 375px.
