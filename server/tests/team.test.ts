import { describe, it, expect, vi, beforeEach } from 'vitest';

// Domain resolution is network-bound (domain-mapper); mock it so tests control
// the resolved brand without a live mapper.
vi.mock('@/utils/domainMapping.js', () => ({
  resolveDomainFromRequest: vi.fn(),
}));

import { resolveDomainFromRequest } from '@/utils/domainMapping.js';
import { getTeamService } from '@/modules/api/v1/team/get.team.service.js';
import { patchTeamService } from '@/modules/api/v1/team/patch.team.service.js';
import { getTeamSearchService } from '@/modules/api/v1/team/get.teamSearch.service.js';

const BRAND = 'brand-1';

type Membership = { userId: string; brandId: string | null; businessId: string | null; role: string };
type User = { id: string; keycloakSub: string; email: string; name: string; surname: string };

function createRepo() {
  const users: User[] = [
    { id: 'u-admin', keycloakSub: 'sub-admin', email: 'admin@x.com', name: 'Ada', surname: 'Admin' },
    { id: 'u-bm', keycloakSub: 'sub-bm', email: 'bm@x.com', name: 'Bruno', surname: 'Manager' },
    { id: 'u-mgr', keycloakSub: 'sub-mgr', email: 'mgr@x.com', name: 'Marta', surname: 'Mgr' },
    { id: 'u-staff', keycloakSub: 'sub-staff', email: 'staff@x.com', name: 'Sara', surname: 'Staff' },
    { id: 'u-user', keycloakSub: 'sub-user', email: 'user@x.com', name: 'Уго', surname: 'User' },
    // targets
    { id: 't-staff', keycloakSub: 'sub-tstaff', email: 'tstaff@x.com', name: 'Tino', surname: 'Staff' },
    { id: 't-mgr', keycloakSub: 'sub-tmgr', email: 'tmgr@x.com', name: 'Tea', surname: 'Manager' },
    { id: 't-bm', keycloakSub: 'sub-tbm', email: 'tbm@x.com', name: 'Bea', surname: 'Brandm' },
    { id: 't-admin', keycloakSub: 'sub-tadmin', email: 'tadmin@x.com', name: 'Aldo', surname: 'Admin' },
    // promotion candidates (plain USER)
    { id: 'c-mario', keycloakSub: 'sub-mario', email: 'mario@x.com', name: 'Mario', surname: 'Rossi' },
    { id: 'c-maria', keycloakSub: 'sub-maria', email: 'maria@x.com', name: 'Maria', surname: 'Bianchi' },
  ];
  const memberships: Membership[] = [
    { userId: 'u-admin', brandId: BRAND, businessId: 'biz-1', role: 'ADMIN' },
    { userId: 'u-bm', brandId: BRAND, businessId: 'biz-1', role: 'BRAND_MANAGER' },
    { userId: 'u-mgr', brandId: BRAND, businessId: 'biz-1', role: 'MANAGER' },
    { userId: 'u-staff', brandId: BRAND, businessId: 'biz-1', role: 'STAFF' },
    { userId: 'u-user', brandId: BRAND, businessId: 'biz-1', role: 'USER' },
    { userId: 't-staff', brandId: BRAND, businessId: 'biz-1', role: 'STAFF' },
    { userId: 't-mgr', brandId: BRAND, businessId: 'biz-1', role: 'MANAGER' },
    { userId: 't-bm', brandId: BRAND, businessId: 'biz-1', role: 'BRAND_MANAGER' },
    { userId: 't-admin', brandId: BRAND, businessId: 'biz-1', role: 'ADMIN' },
    { userId: 'c-mario', brandId: BRAND, businessId: 'biz-1', role: 'USER' },
    { userId: 'c-maria', brandId: BRAND, businessId: 'biz-1', role: 'USER' },
  ];

  return {
    _users: users,
    _memberships: memberships,
    async findUserByKeycloakSub(sub: string) { return users.find((u) => u.keycloakSub === sub) ?? null; },
    async findUserById(id: string) { return users.find((u) => u.id === id) ?? null; },
    async getMembershipByBrand(userId: string, brandId: string) {
      return memberships.find((m) => m.userId === userId && m.brandId === brandId) ?? null;
    },
    async listBrandTeamMembers(brandId: string) {
      return memberships
        .filter((m) => m.brandId === brandId && m.role !== 'USER')
        .map((m) => ({ ...m, user: users.find((u) => u.id === m.userId)! }));
    },
    async searchBrandUserCandidates(brandId: string, q: string, limit: number) {
      const needle = q.toLowerCase();
      return memberships
        .filter((m) => m.brandId === brandId && m.role === 'USER')
        .map((m) => ({ ...m, user: users.find((u) => u.id === m.userId)! }))
        .filter((row) =>
          row.user.email.toLowerCase().includes(needle) ||
          row.user.name.toLowerCase().includes(needle) ||
          row.user.surname.toLowerCase().includes(needle))
        .slice(0, limit);
    },
    async upsertMembership(userId: string, m: { brandId?: string | null; businessId?: string | null; role?: string }) {
      const existing = memberships.find((x) => x.userId === userId && x.brandId === (m.brandId ?? null));
      if (existing) {
        if (m.role) existing.role = m.role;
        return existing;
      }
      const rec: Membership = { userId, brandId: m.brandId ?? null, businessId: m.businessId ?? null, role: m.role ?? 'USER' };
      memberships.push(rec);
      return rec;
    },
  };
}

function makeRequest(opts: { sub?: string; params?: any; body?: any; query?: any; repo: any }) {
  return {
    auth: opts.sub ? { sub: opts.sub } : undefined,
    headers: {},
    params: opts.params ?? {},
    body: opts.body,
    query: opts.query,
    server: { repository: opts.repo },
    log: { error: () => {}, warn: () => {}, info: () => {} },
  } as any;
}

let repo: ReturnType<typeof createRepo>;

beforeEach(() => {
  repo = createRepo();
  (resolveDomainFromRequest as any).mockResolvedValue({ brandId: BRAND, businessId: null, host: null, service: null, label: null, url: null });
});

describe('GET /api/v1/team role guard', () => {
  it('401 when unauthenticated', async () => {
    const res = await getTeamService(makeRequest({ repo }));
    expect(res.statusCode).toBe(401);
  });

  it('400 when domain resolves to no brand', async () => {
    (resolveDomainFromRequest as any).mockResolvedValueOnce(null);
    const res = await getTeamService(makeRequest({ sub: 'sub-admin', repo }));
    expect(res.statusCode).toBe(400);
  });

  it.each([
    ['MANAGER', 'sub-mgr'],
    ['STAFF', 'sub-staff'],
    ['USER', 'sub-user'],
  ])('403 for %s caller', async (_role, sub) => {
    const res = await getTeamService(makeRequest({ sub, repo }));
    expect(res.statusCode).toBe(403);
  });

  it.each([
    ['ADMIN', 'sub-admin'],
    ['BRAND_MANAGER', 'sub-bm'],
  ])('200 for %s caller and excludes USER memberships', async (_role, sub) => {
    const res = await getTeamService(makeRequest({ sub, repo }));
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(Array.isArray(body.members)).toBe(true);
    // USER memberships must not appear.
    expect(body.members.every((m: any) => m.role !== 'USER')).toBe(true);
    // Sorted most-privileged first: ADMIN before BRAND_MANAGER before MANAGER before STAFF.
    expect(body.members[0].role).toBe('ADMIN');
    expect(body.members.map((m: any) => m.userId)).toContain('u-bm');
    const sample = body.members.find((m: any) => m.userId === 'u-staff');
    expect(sample).toMatchObject({ email: 'staff@x.com', name: 'Sara', surname: 'Staff', role: 'STAFF', businessId: 'biz-1' });
  });
});

describe('PATCH /api/v1/team/:userId permission matrix', () => {
  it('404 when target has no membership in brand', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-admin', params: { userId: 'nope' }, body: { role: 'STAFF' }, repo }));
    expect(res.statusCode).toBe(404);
  });

  it('400 (Italian) when caller edits own membership', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-bm', params: { userId: 'u-bm' }, body: { role: 'STAFF' }, repo }));
    expect(res.statusCode).toBe(400);
    expect((res.body as any).message).toBe('Non puoi modificare il tuo ruolo');
  });

  it('400 on invalid role in body (strict zod, ADMIN rejected)', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-admin', params: { userId: 't-staff' }, body: { role: 'ADMIN' }, repo }));
    expect(res.statusCode).toBe(400);
  });

  it('BRAND_MANAGER can set STAFF -> MANAGER', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-bm', params: { userId: 't-staff' }, body: { role: 'MANAGER' }, repo }));
    expect(res.statusCode).toBe(200);
    expect((res.body as any).member).toMatchObject({ userId: 't-staff', role: 'MANAGER', businessId: 'biz-1' });
  });

  it('BRAND_MANAGER can demote MANAGER -> USER', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-bm', params: { userId: 't-mgr' }, body: { role: 'USER' }, repo }));
    expect(res.statusCode).toBe(200);
    expect((res.body as any).member.role).toBe('USER');
  });

  it('BRAND_MANAGER cannot edit a BRAND_MANAGER target', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-bm', params: { userId: 't-bm' }, body: { role: 'STAFF' }, repo }));
    expect(res.statusCode).toBe(403);
  });

  it('BRAND_MANAGER cannot SET role BRAND_MANAGER', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-bm', params: { userId: 't-staff' }, body: { role: 'BRAND_MANAGER' }, repo }));
    expect(res.statusCode).toBe(403);
  });

  it('BRAND_MANAGER cannot edit an ADMIN target', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-bm', params: { userId: 't-admin' }, body: { role: 'STAFF' }, repo }));
    expect(res.statusCode).toBe(403);
  });

  it('ADMIN can promote STAFF -> BRAND_MANAGER', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-admin', params: { userId: 't-staff' }, body: { role: 'BRAND_MANAGER' }, repo }));
    expect(res.statusCode).toBe(200);
    expect((res.body as any).member.role).toBe('BRAND_MANAGER');
  });

  it('ADMIN can edit a BRAND_MANAGER target', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-admin', params: { userId: 't-bm' }, body: { role: 'MANAGER' }, repo }));
    expect(res.statusCode).toBe(200);
    expect((res.body as any).member.role).toBe('MANAGER');
  });

  it('ADMIN cannot edit another ADMIN target', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-admin', params: { userId: 't-admin' }, body: { role: 'MANAGER' }, repo }));
    expect(res.statusCode).toBe(403);
  });

  it('MANAGER caller is forbidden entirely', async () => {
    const res = await patchTeamService(makeRequest({ sub: 'sub-mgr', params: { userId: 't-staff' }, body: { role: 'USER' }, repo }));
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/v1/team/search', () => {
  it('400 when q shorter than 3 chars', async () => {
    const res = await getTeamSearchService(makeRequest({ sub: 'sub-admin', query: { q: 'ma' }, repo }));
    expect(res.statusCode).toBe(400);
  });

  it('403 for non-admin caller', async () => {
    const res = await getTeamSearchService(makeRequest({ sub: 'sub-staff', query: { q: 'mario' }, repo }));
    expect(res.statusCode).toBe(403);
  });

  it('returns only USER-role candidates matching the query', async () => {
    const res = await getTeamSearchService(makeRequest({ sub: 'sub-admin', query: { q: 'mar' }, repo }));
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    const ids = body.users.map((u: any) => u.userId).sort();
    expect(ids).toEqual(['c-maria', 'c-mario']);
    // Team members (e.g. t-mgr "Tea Manager") must never surface as candidates.
    expect(body.users.every((u: any) => u.userId.startsWith('c-'))).toBe(true);
    expect(body.users[0]).toHaveProperty('email');
    expect(body.users[0]).not.toHaveProperty('role');
  });
});
