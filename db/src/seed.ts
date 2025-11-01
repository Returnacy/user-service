import { prisma } from './prismaClient.js';
import { RepositoryPrisma } from './repository.prisma.js';

const repo = new RepositoryPrisma();

// Align with campaign-service seed identifiers
const brandId = '385d4ebb-4c4b-46e9-8701-0d71bfd7ce47';
const businessId = 'af941888-ec4c-458e-b905-21673241af3e';

function randomPick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }

async function main() {
  // Disable seed by default unless explicitly allowed
  if (process.env.ALLOW_SEED !== 'true') {
    console.log('[user-service][db] Seed disabled (set ALLOW_SEED=true to enable)');
    return;
  }
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

  console.log('Seeding demo users...');
  const created: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const sub = `seed-sub-${i}`;
    const email = `seed${i}@example.com`;
    const name = `Seed${i}`;
    const surname = `User${i}`;
    // Make the first user have today's birthday (UTC) so birthday campaign matches at least one user
    const today = new Date();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const thisYear = String(today.getUTCFullYear());
    const birthdayToday = `${thisYear}-${mm}-${dd}`;
    const user = await repo.upsertUserByKeycloakSub(sub, {
      email,
      name,
      surname,
      birthday: i === 1 ? birthdayToday : '1990-01-01',
      userPrivacyPolicyAcceptance: true,
      userTermsAcceptance: true,
      gender: i % 2 === 0 ? 'M' : 'F',
      preferences: { city: i % 2 === 0 ? 'Rome' : 'Milan', tags: ['seed', i], plan: 'free' }
    });
    created.push(user.id);

    // Deterministic membership aligned with campaign-service seed
    await repo.upsertMembership(user.id, { businessId, brandId, role: 'USER' });
  }
  console.log(`Seeded ${created.length} users.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
