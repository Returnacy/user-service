/**
 * Phase 2.4 — copy bcrypt password hashes from Keycloak's Postgres into
 * user-service's Postgres User.passwordHash column.
 *
 * Usage:
 *   KEYCLOAK_DATABASE_URL=postgresql://... \
 *   USER_DATABASE_URL=postgresql://... \
 *   node --experimental-strip-types server/scripts/migrateKeycloakPasswords.ts [--dry-run]
 *
 * Read-only on Keycloak DB. Idempotent on user-service DB (UPDATEs only;
 * re-running with same input is safe).
 */
import { Client as PgClient } from 'pg';

type Args = { dryRun: boolean; realm: string };

function parseArgs(): Args {
  const dryRun = process.argv.includes('--dry-run');
  const realmArgIdx = process.argv.findIndex((a) => a === '--realm');
  const realm = realmArgIdx >= 0 ? (process.argv[realmArgIdx + 1] ?? 'returnacy') : 'returnacy';
  return { dryRun, realm };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

type KeycloakUserRow = {
  kc_sub: string;
  email: string | null;
  username: string | null;
  secret_data: string | null;
  credential_data: string | null;
};

async function main() {
  const { dryRun, realm } = parseArgs();
  const kcUrl = requireEnv('KEYCLOAK_DATABASE_URL');
  const userUrl = requireEnv('USER_DATABASE_URL');

  console.log(`mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`realm: ${realm}`);

  const kc = new PgClient({ connectionString: kcUrl });
  const user = new PgClient({ connectionString: userUrl });

  await Promise.all([kc.connect(), user.connect()]);

  try {
    // Pull every Keycloak user in the realm with a password credential, joined inline
    const { rows } = await kc.query<KeycloakUserRow>(
      `
      SELECT
        u.id            AS kc_sub,
        u.email         AS email,
        u.username      AS username,
        c.secret_data   AS secret_data,
        c.credential_data AS credential_data
      FROM user_entity u
      JOIN realm r ON r.id = u.realm_id
      LEFT JOIN credential c ON c.user_id = u.id AND c.type = 'password'
      WHERE r.name = $1
        AND u.service_account_client_link IS NULL
      `,
      [realm],
    );

    console.log(`found ${rows.length} keycloak users in realm '${realm}'`);

    let updated = 0;
    let noLocalUser = 0;
    let noPasswordCred = 0;
    let unexpectedFormat = 0;

    for (const row of rows) {
      if (!row.secret_data || !row.credential_data) {
        noPasswordCred++;
        continue;
      }

      let hash: string | undefined;
      let algorithm: string | undefined;
      try {
        const secret = JSON.parse(row.secret_data) as { value?: string };
        const cred = JSON.parse(row.credential_data) as { algorithm?: string };
        hash = secret.value;
        algorithm = cred.algorithm ?? 'bcrypt';
      } catch (err) {
        console.warn(`  ! parse error for ${row.email ?? row.username ?? row.kc_sub}:`, err);
        unexpectedFormat++;
        continue;
      }

      if (!hash || typeof hash !== 'string' || !hash.startsWith('$2')) {
        console.warn(`  ! unexpected hash format for ${row.email ?? row.username ?? row.kc_sub}: starts with ${hash?.slice(0, 4) ?? '<empty>'}`);
        unexpectedFormat++;
        continue;
      }

      // Check the local user exists
      const localRes = await user.query<{ id: string; email: string }>(
        'SELECT id, email FROM "User" WHERE "keycloakSub" = $1',
        [row.kc_sub],
      );
      if (localRes.rows.length === 0) {
        noLocalUser++;
        continue;
      }
      const localUser = localRes.rows[0]!;

      if (dryRun) {
        console.log(`  [dry-run] would update ${localUser.email} (${localUser.id}) with ${algorithm} hash starting ${hash.slice(0, 7)}…`);
      } else {
        await user.query(
          'UPDATE "User" SET "passwordHash" = $1, "passwordAlgorithm" = $2, "passwordUpdatedAt" = NOW() WHERE id = $3',
          [hash, algorithm, localUser.id],
        );
      }
      updated++;
    }

    console.log('---');
    console.log(`updated:           ${updated}${dryRun ? ' (would-update)' : ''}`);
    console.log(`no local user:     ${noLocalUser}`);
    console.log(`no password cred:  ${noPasswordCred}`);
    console.log(`unexpected format: ${unexpectedFormat}`);
    console.log(`total seen:        ${rows.length}`);
  } finally {
    await kc.end();
    await user.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
