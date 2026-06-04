/**
 * One-shot backfill: create a chepizza membership for any user that doesn't
 * already have one.
 *
 * Why: post.register.service.ts only creates a membership when domain-mapper
 * resolves the request's host to a (businessId, brandId) pair. While
 * DOMAIN_MAPPER_URL was misconfigured (pointing at the marketing site),
 * registrations silently skipped that block. Affected users exist in
 * the User table but have no UserMembership row → CRM filters them out and
 * stamp/coupon flows misbehave.
 *
 * Usage (from user-service/server/):
 *   DATABASE_URL=<production user-service DB URL> \
 *     pnpm exec node --experimental-strip-types scripts/backfillChepizzaMemberships.ts
 *
 * Idempotent: relies on the @@unique([userId, brandId]) constraint to skip
 * users that already have a chepizza membership. Pass --dry-run to preview.
 */

import { PrismaClient } from '@prisma/client';

const CHEPIZZA_BRAND_ID = '385d4ebb-4c4b-46e9-8701-0d71bfd7ce47';
const CHEPIZZA_BUSINESS_ID = 'af941888-ec4c-458e-b905-21673241af3e';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient();

  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        createdAt: true,
        userMemberships: {
          select: { id: true, brandId: true, businessId: true },
        },
      },
    });

    const missingAll = users.filter((u) =>
      !u.userMemberships.some(
        (m) => m.brandId === CHEPIZZA_BRAND_ID || m.businessId === CHEPIZZA_BUSINESS_ID,
      ),
    );

    // Skip incomplete/abandoned registrations (no email): enrolling them would
    // surface blank ghost customers in the CRM. They are reported separately.
    const skippedIncomplete = missingAll.filter((u) => !u.email || !u.email.trim());
    const missing = missingAll.filter((u) => u.email && u.email.trim());

    console.log(`Total users: ${users.length}`);
    console.log(`Users missing a chepizza membership: ${missingAll.length}`);
    if (skippedIncomplete.length > 0) {
      console.log(`Skipping ${skippedIncomplete.length} incomplete (no-email) user(s):`);
      for (const u of skippedIncomplete) {
        console.log(`  - ${u.id}  (no email)  created=${u.createdAt.toISOString()}`);
      }
    }
    console.log(`Users to enrol: ${missing.length}`);

    if (missing.length === 0) {
      console.log('Nothing to backfill.');
      return;
    }

    console.log('\nUsers to backfill:');
    for (const u of missing) {
      console.log(`  - ${u.id}  ${u.email}  created=${u.createdAt.toISOString()}`);
    }

    if (dryRun) {
      console.log('\n[dry-run] no writes performed.');
      return;
    }

    let created = 0;
    let skipped = 0;
    for (const u of missing) {
      try {
        await prisma.userMembership.create({
          data: {
            userId: u.id,
            brandId: CHEPIZZA_BRAND_ID,
            businessId: CHEPIZZA_BUSINESS_ID,
            role: 'USER',
          },
        });
        created++;
      } catch (err: any) {
        if (err?.code === 'P2002') {
          skipped++;
        } else {
          console.error(`Failed for user ${u.id} (${u.email}):`, err?.message ?? err);
        }
      }
    }

    console.log(`\nCreated: ${created}, skipped (already existed): ${skipped}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
