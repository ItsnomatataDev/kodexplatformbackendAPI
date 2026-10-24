import type pg from 'pg';
import { generateSecret, generateURI, verify } from 'otplib';
import type { InfrastructureConfig } from '../config.js';
import { transaction } from '../db/pool.js';
import {
  digest,
  randomToken,
  seal,
  unseal,
  bootstrapDigest,
} from '../crypto/secrets.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { audit, type AuditMeta } from '../audit/events.js';

export class InfraError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 429 = 401,
    public code = 'Authentication failed',
  ) {
    super(code);
  }
}
export type Principal = {
  id: string;
  account_id: string;
  login: string;
  display_name: string;
  organization_id: string;
  permissions: string[];
  expires_at: Date;
  last_activity_at: Date;
  authenticated_at: Date;
};
// One startup dummy hash per process, with a handled failure. Never create hashing
// work just because another app instance is constructed (tests/replica harnesses).
const dummyHash = hashPassword(randomToken()).catch(() => null);
export class InfrastructureAuth {
  async ready() {
    if (!(await dummyHash)) throw new Error('Password service unavailable');
  }
  constructor(
    readonly pool: pg.Pool,
    readonly config: InfrastructureConfig,
  ) {}
  private hash(purpose: string, value: string) {
    return digest(this.config, purpose, value);
  }
  private expiry(seconds = this.config.challengeSeconds) {
    return new Date(this.config.now().getTime() + seconds * 1000);
  }
  async challenge(
    db: pg.PoolClient,
    purpose: string,
    accountId: string | null = null,
    version: number | null = null,
  ) {
    const token = randomToken();
    await db.query(
      'INSERT INTO infrastructure.auth_challenges(account_id,token_hash,purpose,auth_version,expires_at) VALUES($1,$2,$3,$4,$5)',
      [
        accountId,
        this.hash('challenge', token),
        purpose,
        version,
        this.expiry(),
      ],
    );
    return token;
  }
  async throttleIdentity(session: string, challenge: string) {
    const r = await this.pool.query(
      `SELECT account_id FROM infrastructure.sessions WHERE token_hash=$1
   UNION SELECT account_id FROM infrastructure.auth_challenges WHERE token_hash=$2 LIMIT 1`,
      [this.hash('session', session), this.hash('challenge', challenge)],
    );
    return r.rows[0]?.account_id as string | undefined;
  }
  async stage(token: string) {
    const r = await this.pool.query(
      `SELECT ch.purpose FROM infrastructure.auth_challenges ch
   LEFT JOIN infrastructure.accounts a ON a.id=ch.account_id
   WHERE ch.token_hash=$1 AND ch.consumed_at IS NULL AND ch.expires_at>$2
   AND (ch.purpose='browser' OR (a.auth_version=ch.auth_version AND a.status<>'disabled' AND a.organization_id=$3))`,
      [
        this.hash('challenge', token),
        this.config.now(),
        this.config.organizationId,
      ],
    );
    return r.rows[0]?.purpose ?? 'browser';
  }
  async browser() {
    return transaction(this.pool, (db) => this.challenge(db, 'browser'));
  }
  async context(session: string | undefined, challenge: string | undefined) {
    if (session) {
      const p = await this.session(session);
      if (p) return { token: session, kind: 'session' as const };
    }
    if (challenge) {
      const r = await this.pool.query(
        'SELECT 1 FROM infrastructure.auth_challenges WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>$2',
        [this.hash('challenge', challenge), this.config.now()],
      );
      if (r.rowCount) return { token: challenge, kind: 'challenge' as const };
    }
    return null;
  }
  async session(token: string): Promise<Principal | null> {
    const r = await this.pool.query(
      `SELECT s.id,s.account_id,s.expires_at,s.last_activity_at,s.authenticated_at,a.login,a.display_name,a.organization_id,
   ARRAY(SELECT permission FROM infrastructure.account_permissions p WHERE p.account_id=a.id) AS permissions
   FROM infrastructure.sessions s JOIN infrastructure.accounts a ON a.id=s.account_id
   WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND s.last_activity_at>$3
    AND a.status='active' AND s.auth_version=a.auth_version AND a.organization_id=$4`,
      [
        this.hash('session', token),
        this.config.now(),
        new Date(this.config.now().getTime() - this.config.idleSeconds * 1000),
        this.config.organizationId,
      ],
    );
    return r.rows[0] ?? null;
  }
  // Durable shared throttles. Separate committed transaction retains failures and survives process restarts.
  async limit(keys: { key: string; limit: number }[], meta: AuditMeta) {
    await transaction(this.pool, async (db) => {
      for (const { key, limit } of [...keys].sort((a, b) =>
        a.key.localeCompare(b.key),
      )) {
        const rateKey = this.hash('rate', key);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          rateKey,
        ]);
        const r = await db.query(
          'SELECT count(*)::int AS n FROM infrastructure.authentication_attempts WHERE rate_key=$1 AND attempted_at>$2',
          [rateKey, new Date(this.config.now().getTime() - 900000)],
        );
        if (r.rows[0].n >= limit) throw new InfraError(429, 'Try again later');
        await db.query(
          'INSERT INTO infrastructure.authentication_attempts(rate_key,attempted_at,action) VALUES($1,$2,$3)',
          [rateKey, this.config.now(), 'authentication'],
        );
      }
    });
  }
  async denialIdentity(
    session: string,
    challenge: string,
  ): Promise<string | null> {
    if (session) {
      const principal = await this.session(session);
      if (principal) return principal.account_id;
    }
    if (!challenge) return null;
    const r = await this.pool.query(
      `SELECT ch.account_id FROM infrastructure.auth_challenges ch
      JOIN infrastructure.accounts a ON a.id=ch.account_id
      WHERE ch.token_hash=$1 AND ch.consumed_at IS NULL AND ch.expires_at>$2
      AND ch.auth_version=a.auth_version AND a.status<>'disabled' AND a.organization_id=$3`,
      [
        this.hash('challenge', challenge),
        this.config.now(),
        this.config.organizationId,
      ],
    );
    return r.rows[0]?.account_id ?? null;
  }
  async denied(
    meta: AuditMeta,
    reason: string,
    accountId: string | null = null,
  ) {
    await this.pool.query('SELECT infrastructure.record_denial($1,$2,$3,$4)', [
      reason,
      meta.actor,
      accountId,
      meta.requestId,
    ]);
  }
  private async locked(db: pg.PoolClient, token: string, purposes: string[]) {
    // Account first, then challenge: common lock order across MFA, reset and session transitions.
    const found = await db.query(
      'SELECT account_id FROM infrastructure.auth_challenges WHERE token_hash=$1',
      [this.hash('challenge', token)],
    );
    const id = found.rows[0]?.account_id;
    if (!id) throw new InfraError();
    const a = (
      await db.query(
        'SELECT * FROM infrastructure.accounts WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    const ch = (
      await db.query(
        'SELECT * FROM infrastructure.auth_challenges WHERE token_hash=$1 FOR UPDATE',
        [this.hash('challenge', token)],
      )
    ).rows[0];
    if (
      !a ||
      !ch ||
      ch.consumed_at ||
      ch.expires_at <= this.config.now() ||
      !purposes.includes(ch.purpose) ||
      a.auth_version !== ch.auth_version ||
      a.status === 'disabled' ||
      a.organization_id !== this.config.organizationId
    )
      throw new InfraError();
    return { a, ch };
  }
  private async consume(db: pg.PoolClient, id: string) {
    await db.query(
      'UPDATE infrastructure.auth_challenges SET consumed_at=$2 WHERE id=$1',
      [id, this.config.now()],
    );
  }
  async login(
    login: string,
    password: string,
    browser: string,
    meta: AuditMeta,
  ) {
    return transaction(this.pool, async (db) => {
      const a = (
        await db.query(
          'SELECT * FROM infrastructure.accounts WHERE login=$1 FOR UPDATE',
          [login.trim().toLowerCase()],
        )
      ).rows[0];
      const hash = a?.password_hash ?? (await dummyHash);
      if (!hash) throw new Error('Password service unavailable');
      const valid = await verifyPassword(hash, password);
      if (
        !valid ||
        a?.status !== 'active' ||
        a.organization_id !== this.config.organizationId
      )
        throw new InfraError();
      const consumed = await db.query(
        `UPDATE infrastructure.auth_challenges SET consumed_at=$2 WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>$2 RETURNING id`,
        [this.hash('challenge', browser), this.config.now()],
      );
      if (!consumed.rowCount) throw new InfraError();
      const token = await this.challenge(db, 'mfa', a.id, a.auth_version);
      await audit(db, meta, 'password.verified', a.id);
      return token;
    });
  }
  async redeem(capability: string, browser: string, meta: AuditMeta) {
    return transaction(this.pool, async (db) => {
      const found = (
        await db.query(
          'SELECT account_id FROM infrastructure.bootstrap_tokens WHERE token_hash=$1',
          [bootstrapDigest(capability)],
        )
      ).rows[0];
      if (!found) throw new InfraError();
      const a = (
        await db.query(
          'SELECT * FROM infrastructure.accounts WHERE id=$1 FOR UPDATE',
          [found.account_id],
        )
      ).rows[0];
      if (
        !a ||
        a.status !== 'pending' ||
        a.organization_id !== this.config.organizationId
      )
        throw new InfraError();
      const used = await db.query(
        'UPDATE infrastructure.bootstrap_tokens SET consumed_at=$2 WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>$2 RETURNING id',
        [bootstrapDigest(capability), this.config.now()],
      );
      const b = await db.query(
        `UPDATE infrastructure.auth_challenges SET consumed_at=$2 WHERE token_hash=$1 AND purpose='browser' AND consumed_at IS NULL AND expires_at>$2 RETURNING id`,
        [this.hash('challenge', browser), this.config.now()],
      );
      if (!used.rowCount || !b.rowCount) throw new InfraError();
      const token = await this.challenge(db, 'enroll', a.id, a.auth_version);
      await audit(db, meta, 'bootstrap.redeemed', a.id);
      return token;
    });
  }
  async enrollmentStart(token: string, password: string, meta: AuditMeta) {
    const passwordHash = await hashPassword(password);
    return transaction(this.pool, async (db) => {
      const { a, ch } = await this.locked(db, token, ['enroll', 'recovery']);
      if (
        ch.purpose === 'recovery' &&
        !(await verifyPassword(a.password_hash, password))
      )
        throw new InfraError();
      const secret = generateSecret();
      await db.query(
        'UPDATE infrastructure.auth_challenges SET pending_password_hash=$2,pending_secret_box=$3 WHERE id=$1',
        [ch.id, passwordHash, seal(this.config, a.id, secret)],
      );
      await audit(db, meta, 'enrollment.started', a.id);
      return {
        uri: generateURI({
          issuer: 'Kodex Infrastructure',
          label: a.login,
          secret,
        }),
      };
    });
  }
  private async otp(secret: string, token: string, last = -1) {
    if (!/^\d{6}$/.test(token)) throw new InfraError();
    const result = await verify({
      secret,
      token,
      epoch: Math.floor(this.config.now().getTime() / 1000),
      epochTolerance: 30,
      ...(last >= 0 ? { afterTimeStep: last } : {}),
    });
    if (!result.valid || !('timeStep' in result)) throw new InfraError();
    return result.timeStep;
  }
  async enrollmentConfirm(token: string, otp: string, meta: AuditMeta) {
    return transaction(this.pool, async (db) => {
      const { a, ch } = await this.locked(db, token, ['enroll', 'recovery']);
      if (!ch.pending_secret_box || !ch.pending_password_hash)
        throw new InfraError();
      const counter = await this.otp(
        unseal(this.config, a.id, ch.pending_secret_box),
        otp,
      );
      await db.query(
        `INSERT INTO infrastructure.mfa_credentials(account_id,secret_box,last_counter,confirmed_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(account_id) DO UPDATE SET secret_box=excluded.secret_box,last_counter=excluded.last_counter,confirmed_at=excluded.confirmed_at`,
        [a.id, ch.pending_secret_box, counter, this.config.now()],
      );
      await db.query(
        `UPDATE infrastructure.accounts SET password_hash=$2,status='active',auth_version=auth_version+1 WHERE id=$1`,
        [a.id, ch.pending_password_hash],
      );
      await db.query(
        'UPDATE infrastructure.sessions SET revoked_at=$2 WHERE account_id=$1 AND revoked_at IS NULL',
        [a.id, this.config.now()],
      );
      await db.query(
        'UPDATE infrastructure.auth_challenges SET consumed_at=$2,pending_secret_box=NULL,pending_password_hash=NULL WHERE account_id=$1',
        [a.id, this.config.now()],
      );
      await db.query(
        'DELETE FROM infrastructure.recovery_codes WHERE account_id=$1',
        [a.id],
      );
      const codes = Array.from({ length: 10 }, () => randomToken());
      for (const code of codes)
        await db.query(
          'INSERT INTO infrastructure.recovery_codes(account_id,code_hash) VALUES($1,$2)',
          [a.id, this.hash('recovery', code)],
        );
      await audit(db, meta, 'enrollment.confirmed', a.id);
      return { recoveryCodes: codes };
    });
  }
  async mfa(token: string, otp: string, meta: AuditMeta) {
    return transaction(this.pool, async (db) => {
      const { a, ch } = await this.locked(db, token, ['mfa']);
      if (a.status !== 'active') throw new InfraError();
      await this.acceptOtp(db, a.id, otp);
      await this.consume(db, ch.id);
      const session = randomToken(),
        now = this.config.now();
      await db.query(
        'INSERT INTO infrastructure.sessions(account_id,token_hash,auth_version,created_at,last_activity_at,expires_at,authenticated_at) VALUES($1,$2,$3,$4,$4,$5,$4)',
        [
          a.id,
          this.hash('session', session),
          a.auth_version,
          now,
          this.expiry(this.config.absoluteSeconds),
        ],
      );
      await audit(db, meta, 'session.created', a.id);
      return session;
    });
  }
  private async acceptOtp(db: pg.PoolClient, account: string, otp: string) {
    const m = (
      await db.query(
        'SELECT * FROM infrastructure.mfa_credentials WHERE account_id=$1 FOR UPDATE',
        [account],
      )
    ).rows[0];
    if (!m) throw new InfraError();
    const counter = await this.otp(
      unseal(this.config, account, m.secret_box),
      otp,
      Number(m.last_counter),
    );
    await db.query(
      'UPDATE infrastructure.mfa_credentials SET last_counter=$2 WHERE account_id=$1',
      [account, counter],
    );
  }
  async recovery(token: string, code: string, meta: AuditMeta) {
    return transaction(this.pool, async (db) => {
      const { a, ch } = await this.locked(db, token, ['mfa']);
      const r = await db.query(
        'UPDATE infrastructure.recovery_codes SET used_at=$3 WHERE account_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id',
        [a.id, this.hash('recovery', code), this.config.now()],
      );
      if (!r.rowCount) throw new InfraError();
      await this.consume(db, ch.id);
      const next = await this.challenge(db, 'recovery', a.id, a.auth_version);
      await audit(db, meta, 'recovery.redeemed', a.id);
      return next;
    });
  }
  async sessionAction(
    token: string,
    action:
      'logout' | 'logout-all' | 'activity' | 'reauthenticate' | 'mfa-replace',
    meta: AuditMeta,
    password = '',
    otp = '',
  ) {
    return transaction(this.pool, async (db) => {
      const found = (
        await db.query(
          'SELECT account_id FROM infrastructure.sessions WHERE token_hash=$1',
          [this.hash('session', token)],
        )
      ).rows[0];
      if (!found) throw new InfraError();
      const a = (
        await db.query(
          'SELECT * FROM infrastructure.accounts WHERE id=$1 FOR UPDATE',
          [found.account_id],
        )
      ).rows[0];
      const s = (
        await db.query(
          'SELECT * FROM infrastructure.sessions WHERE token_hash=$1 FOR UPDATE',
          [this.hash('session', token)],
        )
      ).rows[0];
      const now = this.config.now();
      if (
        !s ||
        s.revoked_at ||
        s.expires_at <= now ||
        s.last_activity_at.getTime() + this.config.idleSeconds * 1000 <=
          now.getTime() ||
        a.status !== 'active' ||
        s.auth_version !== a.auth_version ||
        a.organization_id !== this.config.organizationId
      )
        throw new InfraError();
      if (
        action === 'logout-all' &&
        s.authenticated_at.getTime() + this.config.freshSeconds * 1000 <=
          now.getTime()
      )
        throw new InfraError(403, 'Fresh authentication required');
      let next: string | undefined;
      if (action === 'mfa-replace') {
        if (!(await verifyPassword(a.password_hash, password)))
          throw new InfraError();
        await this.acceptOtp(db, a.id, otp);
        await db.query(
          'UPDATE infrastructure.accounts SET auth_version=auth_version+1 WHERE id=$1',
          [a.id],
        );
        await db.query(
          'UPDATE infrastructure.sessions SET revoked_at=$2 WHERE account_id=$1',
          [a.id, now],
        );
        await db.query(
          'UPDATE infrastructure.auth_challenges SET consumed_at=$2 WHERE account_id=$1',
          [a.id, now],
        );
        next = await this.challenge(db, 'recovery', a.id, a.auth_version + 1);
      } else if (action === 'reauthenticate') {
        if (!(await verifyPassword(a.password_hash, password)))
          throw new InfraError();
        await this.acceptOtp(db, a.id, otp);
        next = randomToken();
        await db.query(
          'UPDATE infrastructure.sessions SET token_hash=$2,authenticated_at=$3,last_activity_at=$3 WHERE id=$1',
          [s.id, this.hash('session', next), now],
        );
      } else if (action === 'activity')
        await db.query(
          'UPDATE infrastructure.sessions SET last_activity_at=$2 WHERE id=$1',
          [s.id, now],
        );
      else
        await db.query(
          `UPDATE infrastructure.sessions SET revoked_at=$2 WHERE ${action === 'logout-all' ? 'account_id' : 'id'}=$1 AND revoked_at IS NULL`,
          [action === 'logout-all' ? a.id : s.id, now],
        );
      if (action !== 'activity')
        await audit(db, meta, `session.${action}`, a.id);
      return next;
    });
  }
}
