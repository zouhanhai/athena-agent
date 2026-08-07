import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { createSecretCipher } from "../src/employees/crypto.js";
import {
  MagicLinkAuthService,
  PostgresAuthTokenStore,
} from "../src/employees/auth.js";
import { PostgresEmployeeRegistry } from "../src/employees/employees.js";
import {
  InvitationService,
  PostgresInvitationStore,
  type InvitationMailer,
} from "../src/employees/invitations.js";

const KEY = "d3d1e5d0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6";

interface SentInvite {
  to: string;
  inviteUrl: string;
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `invite link should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://hh@/athena_test?host=/var/run/postgresql";

let pool: pg.Pool | null = null;
let invitations: InvitationService | null = null;
let tokens: PostgresAuthTokenStore | null = null;
let employees: PostgresEmployeeRegistry | null = null;
let initPromise: Promise<InvitationService | null> | null = null;

async function initPg(): Promise<InvitationService | null> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        pool = new pg.Pool({ connectionString });
        employees = new PostgresEmployeeRegistry({ pool, cipher: createSecretCipher(KEY) });
        await employees.seed();
        tokens = new PostgresAuthTokenStore({ pool });
        const sent: SentInvite[] = [];
        const mailer: InvitationMailer = {
          async sendInvitation(input) {
            sent.push({ to: input.to, inviteUrl: input.inviteUrl });
          },
        };
        invitations = new InvitationService({
          registry: employees,
          tokens,
          store: new PostgresInvitationStore({ pool }),
          mailer,
          appBaseUrl: "http://localhost:5173",
        });
        return invitations;
      } catch (err) {
        console.error("PG integration skipped:", err instanceof Error ? err.message : err);
        return null;
      }
    })();
  }
  return initPromise;
}

test(
  "Postgres invitations: invite token is hashed at rest, resolve + single-use register",
  async (t) => {
    const service = await initPg();
    if (!service) {
      return t.skip("postgres not available");
    }
    const email = `pg-invite-${Date.now()}@caleo.com`;
    const sent: SentInvite[] = [];
    const mailer: InvitationMailer = {
      async sendInvitation(input) {
        sent.push({ to: input.to, inviteUrl: input.inviteUrl });
      },
    };
    const local = new InvitationService({
      registry: employees!,
      tokens: tokens!,
      store: new PostgresInvitationStore({ pool: pool! }),
      mailer,
      appBaseUrl: "http://localhost:5173",
    });

    await local.invite(email);
    assert.equal(sent.length, 1);
    const rawToken = tokenFromUrl(sent[0].inviteUrl);

    const rows = await pool!.query(`SELECT token_hash FROM auth_invitations WHERE email = $1`, [
      email,
    ]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].token_hash, createHash("sha256").update(rawToken).digest("hex"));
    assert.notEqual(rows.rows[0].token_hash, rawToken, "raw token must not be stored");

    assert.deepEqual(await local.resolveInvitation(rawToken), { email });

    const { employee } = await local.registerInvitedEmployee(rawToken, {
      display_name: "PG Carol",
    });
    assert.equal(employee.email, email);

    assert.equal(await local.resolveInvitation(rawToken), null, "consumed token must not resolve");
  },
);

test(
  "Postgres invitations: end-to-end registration with session (integration)",
  async (t) => {
    const service = await initPg();
    if (!service) {
      return t.skip("postgres not available");
    }
    const email = `pg-invite-full-${Date.now()}@caleo.com`;
    const sent: SentInvite[] = [];
    const mailer: InvitationMailer = {
      async sendInvitation(input) {
        sent.push({ to: input.to, inviteUrl: input.inviteUrl });
      },
    };
    const local = new InvitationService({
      registry: employees!,
      tokens: tokens!,
      store: new PostgresInvitationStore({ pool: pool! }),
      mailer,
      appBaseUrl: "http://localhost:5173",
    });
    await local.invite(email);
    assert.equal(sent.length, 1);
    const token = tokenFromUrl(sent[0].inviteUrl);

    const { session_token, employee } = await local.registerInvitedEmployee(token, {
      display_name: "PG Carol",
      github_credential: { type: "token", value: "ghp_pg_secret" },
    });
    assert.equal(employee.email, email);
    assert.equal(employee.role, "member");

    const stored = await pool!.query(
      `SELECT github_credential_type, github_credential_enc FROM employees WHERE email = $1`,
      [email],
    );
    assert.equal(stored.rows[0].github_credential_type, "token");
    assert.notEqual(stored.rows[0].github_credential_enc, "ghp_pg_secret");
    assert.match(stored.rows[0].github_credential_enc, /^v1:/, "credential is ciphertext at rest");

    const decoded = await employees!.getGithubCredential(email);
    assert.equal(decoded?.value, "ghp_pg_secret");

    const auth = new MagicLinkAuthService({
      registry: employees!,
      tokens: tokens!,
      mailer,
      appBaseUrl: "http://localhost:5173",
    });
    assert.equal((await auth.getEmployeeForSession(session_token))?.email, email);

    assert.equal(
      await local.resolveInvitation(token),
      null,
      "consumed invite token must not resolve",
    );
  },
);

after(async () => {
  invitations = null;
  tokens = null;
  employees = null;
  if (pool) {
    await pool.end();
    pool = null;
  }
});
