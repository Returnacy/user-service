import { describe, it, expect, vi } from 'vitest';

import { seedBrandAdmin, type SeedBrandAdminRepo } from '../src/seedBrandAdmin.js';

const BRAND = 'brand-quieora';
const BUSINESS = 'biz-quieora';

type UserRow = { id: string; keycloakSub: string; email: string; name: string; surname: string; birthday: string; userPrivacyPolicyAcceptance: boolean; userTermsAcceptance: boolean };
type MembershipRow = { id: string; userId: string; businessId: string | null; brandId: string | null; role: string };

// In-memory stand-in for RepositoryPrisma, mirroring the branch upsertMembership
// takes on the real one (by business when there is one, else by brand).
function createRepo(seedUsers: UserRow[] = []) {
  const users: UserRow[] = [...seedUsers];
  const memberships: MembershipRow[] = [];
  const repo = {
    _users: users,
    _memberships: memberships,
    findUserByKeycloakSub: vi.fn(async (sub: string) => users.find((u) => u.keycloakSub === sub) ?? null),
    upsertUserByKeycloakSub: vi.fn(async (sub: string, data: Record<string, unknown>) => {
      const existing = users.find((u) => u.keycloakSub === sub);
      if (existing) {
        Object.assign(existing, data);
        return existing;
      }
      const created: UserRow = {
        id: `u_${users.length + 1}`,
        keycloakSub: sub,
        email: String(data.email ?? ''),
        name: String(data.name ?? ''),
        surname: String(data.surname ?? ''),
        birthday: String(data.birthday ?? ''),
        userPrivacyPolicyAcceptance: !!data.userPrivacyPolicyAcceptance,
        userTermsAcceptance: !!data.userTermsAcceptance,
      };
      users.push(created);
      return created;
    }),
    getMembership: vi.fn(async (userId: string, businessId: string) =>
      memberships.find((m) => m.userId === userId && m.businessId === businessId) ?? null),
    getMembershipByBrand: vi.fn(async (userId: string, brandId: string) =>
      memberships.find((m) => m.userId === userId && m.brandId === brandId) ?? null),
    upsertMembership: vi.fn(async (userId: string, membership: { businessId?: string | null; brandId?: string | null; role?: string }) => {
      const businessId = membership.businessId ?? null;
      const brandId = membership.brandId ?? null;
      const existing = businessId
        ? memberships.find((m) => m.userId === userId && m.businessId === businessId)
        : memberships.find((m) => m.userId === userId && m.brandId === brandId);
      if (existing) {
        existing.brandId = brandId;
        if (membership.role) existing.role = membership.role;
        return existing;
      }
      const created: MembershipRow = {
        id: `m_${memberships.length + 1}`,
        userId,
        businessId,
        brandId,
        role: membership.role ?? 'USER',
      };
      memberships.push(created);
      return created;
    }),
  };
  return repo;
}

function ownerRow(): UserRow {
  return {
    id: 'u_owner',
    keycloakSub: 'sub-owner',
    email: 'riccardo@quieora.it',
    name: 'Riccardo',
    surname: 'Fabbian',
    birthday: '1988-04-12',
    userPrivacyPolicyAcceptance: true,
    userTermsAcceptance: true,
  };
}

const input = {
  brandId: BRAND,
  businessId: BUSINESS,
  email: 'riccardo@quieora.it',
  sub: 'sub-owner',
  name: 'Owner',
  surname: '',
  birthday: '1970-01-01',
};

describe('seedBrandAdmin — existing owner account', () => {
  it('leaves name, surname, birthday and consents untouched', async () => {
    const repo = createRepo([ownerRow()]);
    repo.upsertMembership.mockClear();

    const result = await seedBrandAdmin(repo as unknown as SeedBrandAdminRepo, input);

    expect(repo.upsertUserByKeycloakSub).not.toHaveBeenCalled();
    expect(repo._users[0]).toMatchObject({
      name: 'Riccardo',
      surname: 'Fabbian',
      birthday: '1988-04-12',
    });
    expect(result.user).toBe('kept');
    expect(result.userId).toBe('u_owner');
  });

  it('still upserts the ADMIN membership on the given brand/business', async () => {
    const repo = createRepo([ownerRow()]);

    const result = await seedBrandAdmin(repo as unknown as SeedBrandAdminRepo, input);

    expect(repo._memberships).toEqual([
      { id: 'm_1', userId: 'u_owner', businessId: BUSINESS, brandId: BRAND, role: 'ADMIN' },
    ]);
    expect(result.membership).toBe('created');
  });

  it('re-roles a membership the owner already has, and reports it as updated', async () => {
    const repo = createRepo([ownerRow()]);
    await repo.upsertMembership('u_owner', { businessId: BUSINESS, brandId: BRAND, role: 'USER' });

    const result = await seedBrandAdmin(repo as unknown as SeedBrandAdminRepo, input);

    expect(repo._memberships).toHaveLength(1);
    expect(repo._memberships[0]!.role).toBe('ADMIN');
    expect(result.membership).toBe('updated');
  });

  it('is idempotent: a second run changes nothing', async () => {
    const repo = createRepo([ownerRow()]);

    const first = await seedBrandAdmin(repo as unknown as SeedBrandAdminRepo, input);
    const second = await seedBrandAdmin(repo as unknown as SeedBrandAdminRepo, input);

    expect(first.membership).toBe('created');
    expect(second.membership).toBe('updated');
    expect(repo._users).toHaveLength(1);
    expect(repo._memberships).toHaveLength(1);
    expect(repo._users[0]).toMatchObject({ name: 'Riccardo', surname: 'Fabbian', birthday: '1988-04-12' });
  });

  it('flags an ADMIN_EMAIL that does not match the account behind ADMIN_SUB', async () => {
    const repo = createRepo([ownerRow()]);

    const result = await seedBrandAdmin(repo as unknown as SeedBrandAdminRepo, { ...input, email: 'someone.else@quieora.it' });

    expect(result.emailMismatch).toBe('riccardo@quieora.it');
    expect(repo.upsertUserByKeycloakSub).not.toHaveBeenCalled();
  });
});

describe('seedBrandAdmin — brand-new account', () => {
  it('creates the user with the supplied details plus the ADMIN membership', async () => {
    const repo = createRepo();

    const result = await seedBrandAdmin(repo as unknown as SeedBrandAdminRepo, {
      ...input,
      name: 'Riccardo',
      surname: 'Fabbian',
      birthday: '1988-04-12',
    });

    expect(result.user).toBe('created');
    expect(result.membership).toBe('created');
    expect(repo._users[0]).toMatchObject({
      keycloakSub: 'sub-owner',
      email: 'riccardo@quieora.it',
      name: 'Riccardo',
      surname: 'Fabbian',
      birthday: '1988-04-12',
      userPrivacyPolicyAcceptance: true,
      userTermsAcceptance: true,
    });
    expect(repo._memberships[0]).toMatchObject({ brandId: BRAND, businessId: BUSINESS, role: 'ADMIN' });
  });

  it('falls back to the placeholder details when none are supplied', async () => {
    const repo = createRepo();

    await seedBrandAdmin(repo as unknown as SeedBrandAdminRepo, {
      brandId: BRAND,
      businessId: null,
      email: 'owner@example.com',
      sub: 'sub-new',
    });

    expect(repo._users[0]).toMatchObject({ name: 'Owner', surname: '', birthday: '1970-01-01' });
    expect(repo._memberships[0]).toMatchObject({ brandId: BRAND, businessId: null, role: 'ADMIN' });
  });

  it('looks the membership up by brand when there is no business', async () => {
    const repo = createRepo([ownerRow()]);

    await seedBrandAdmin(repo as unknown as SeedBrandAdminRepo, { ...input, businessId: null });

    expect(repo.getMembershipByBrand).toHaveBeenCalledWith('u_owner', BRAND);
    expect(repo.getMembership).not.toHaveBeenCalled();
  });
});
