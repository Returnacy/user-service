/**
 * user-service seed.
 *
 * Three jobs, all gated behind ALLOW_SEED:
 *  1. legal document defaults (privacy / terms / marketing) — always safe;
 *  2. provisioning a new brand's first ADMIN, so the team API has someone to
 *     act from. patch.team.service.ts deliberately refuses to *assign* ADMIN,
 *     so the first one has to be created out of band — here, rather than by
 *     hand-editing a live database;
 *  3. demo users, now opt-in via SEED_DEMO_USERS.
 *
 * The Che Pizza brand/business ids used to be hardcoded here, so a stray
 * `pnpm seed` against any DATABASE_URL wrote one client's tenant into it, with
 * 12 fake customers attached. Both the tenant and the demo users are now
 * explicit inputs.
 *
 * Run:
 *   ALLOW_SEED=true DATABASE_URL=... \
 *   BRAND_ID=... BUSINESS_ID=... \
 *   ADMIN_EMAIL=... ADMIN_SUB=... [ADMIN_NAME=... ADMIN_SURNAME=...] \
 *   pnpm --filter @user-service/db seed
 *
 * ADMIN_NAME / ADMIN_SURNAME / ADMIN_BIRTHDAY only ever apply to an account
 * this seed has to create; an owner who registered himself keeps the details he
 * typed in (see seedBrandAdmin.ts).
 *
 * See PROVISION-BRAND.md.
 */
import { prisma } from './prismaClient.js';
import { RepositoryPrisma } from './repository.prisma.js';
import { seedBrandAdmin, type SeedBrandAdminResult } from './seedBrandAdmin.js';

const repo = new RepositoryPrisma();

function envVar(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function randomPick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }

async function seedPolicies() {
  console.log('Seeding default policies...');
  // Only create defaults if no versions exist yet
  const existingPP = await prisma.privacyPolicy.findFirst();
  if (!existingPP) {
    await prisma.privacyPolicy.create({ data: { version: 'v1', content: 'Default Privacy Policy (dev). Replace with your content.' } });
    console.log('  - Created PrivacyPolicy v1');
  }
  const existingTOS = await prisma.termsOfService.findFirst();
  if (!existingTOS) {
    await prisma.termsOfService.create({ data: { version: 'v1', content: 'Default Terms of Service (dev). Replace with your content.' } });
    console.log('  - Created TermsOfService v1');
  }
  const existingMT = await prisma.marketingTerms.findFirst();
  if (!existingMT) {
    await prisma.marketingTerms.create({ data: { version: 'v1', content: 'Default Marketing Policy (dev). Replace with your content.' } });
    console.log('  - Created MarketingTerms v1');
  }
}

async function runBrandAdminSeed(brandId: string, businessId: string | null): Promise<SeedBrandAdminResult | null> {
  const email = envVar('ADMIN_EMAIL');
  if (!email) {
    console.log('  - ADMIN_EMAIL not set; skipping brand admin');
    return null;
  }
  // keycloakSub is the identity a JWT's `sub` carries. For a brand-new client
  // there is no account yet, so the operator supplies the sub and the owner
  // registers against it; leaving it to chance produces a second account that
  // holds no ADMIN membership.
  const sub = envVar('ADMIN_SUB');
  if (!sub) {
    throw new Error('ADMIN_SUB is required when ADMIN_EMAIL is set (the keycloakSub / JWT sub of the owner account)');
  }

  const result = await seedBrandAdmin(repo, {
    brandId,
    businessId,
    email,
    sub,
    name: envVar('ADMIN_NAME'),
    surname: envVar('ADMIN_SURNAME'),
    birthday: envVar('ADMIN_BIRTHDAY'),
  });

  console.log(`  - ADMIN membership for ${email} on brand ${brandId}`);
  console.log('    (add this sub to PLATFORM_ADMIN_SUBS only if the person operates the platform, not just this brand)');
  return result;
}

function reportBrandAdmin(result: SeedBrandAdminResult | null) {
  if (!result) return;
  console.log('[user-service][db] Brand admin summary:');
  console.log(result.user === 'created'
    ? `  - user: created (${result.userId})`
    : `  - user: kept existing user ${result.userId} — name, birthday and consents left untouched`);
  console.log(`  - membership: ${result.membership} (role ADMIN)`);
  if (result.emailMismatch) {
    console.log(`  - WARNING: the account behind ADMIN_SUB has email ${result.emailMismatch}, not the ADMIN_EMAIL you passed.`);
    console.log('    Nothing was overwritten, but check you promoted the right person.');
  }
}

async function seedDemoUsers(brandId: string, businessId: string | null) {
  console.log('Seeding demo users...');
  const created: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const sub = `seed-sub-${i}`;
    const today = new Date();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const thisYear = String(today.getUTCFullYear());
    const birthdayToday = `${thisYear}-${mm}-${dd}`;
    const user = await repo.upsertUserByKeycloakSub(sub, {
      email: `seed${i}@example.com`,
      name: `Seed${i}`,
      surname: `User${i}`,
      // First user has today's birthday so a birthday campaign matches someone.
      birthday: i === 1 ? birthdayToday : '1990-01-01',
      userPrivacyPolicyAcceptance: true,
      userTermsAcceptance: true,
      gender: i % 2 === 0 ? 'M' : 'F',
      preferences: { city: randomPick(['Rome', 'Milan']), tags: ['seed', i], plan: 'free' },
    } as any);
    created.push(user.id);
    await repo.upsertMembership(user.id, { businessId, brandId, role: 'USER' as any });
  }
  console.log(`Seeded ${created.length} demo users.`);
}

async function main() {
  // Disable seed by default unless explicitly allowed
  if (process.env.ALLOW_SEED !== 'true') {
    console.log('[user-service][db] Seed disabled (set ALLOW_SEED=true to enable)');
    return;
  }

  await seedPolicies();

  // No tenant given → policies only. This is what keeps a bare `pnpm seed`
  // from writing brand data into whatever DATABASE_URL happens to be set.
  const brandId = envVar('BRAND_ID');
  if (!brandId) {
    console.log('[user-service][db] BRAND_ID not set; seeded policies only.');
    return;
  }
  const businessId = envVar('BUSINESS_ID') ?? null;

  const brandAdmin = await runBrandAdminSeed(brandId, businessId);

  if (process.env.SEED_DEMO_USERS === 'true') {
    await seedDemoUsers(brandId, businessId);
  }

  reportBrandAdmin(brandAdmin);
  console.log('[user-service][db] Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
