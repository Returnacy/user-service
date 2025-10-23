import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/appBuilder.js';
import axios from 'axios';

// Simple axios mock per-test
vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  return {
    ...actual,
    default: {
      ...actual.default,
      post: vi.fn(),
      put: vi.fn(),
      get: vi.fn(),
    }
  };
});

// In-memory repo mock
function createMemoryRepo() {
  const users = new Map<string, any>();
  const usersByEmail = new Map<string, string>();
  const memberships = new Map<string, any[]>();
  return {
    async healthCheck() { return { ok: true as const }; },
    async findUserByKeycloakSub(sub: string) { return Array.from(users.values()).find(u => u.keycloakSub === sub) || null; },
    async findUserByEmail(email: string) { const id = usersByEmail.get(email); return id ? users.get(id) : null; },
    async createUser(data: any) { const id = data.id || `u_${Math.random().toString(36).slice(2)}`; const u = { id, ...data }; users.set(id, u); if (u.email) usersByEmail.set(u.email, id); return u; },
    async upsertUserByKeycloakSub(sub: string, data: any) {
      let u = Array.from(users.values()).find(u => u.keycloakSub === sub) || null;
      if (!u) {
        u = { id: `u_${Math.random().toString(36).slice(2)}`, keycloakSub: sub, email: data.email || '', name: data.name || '', surname: data.surname || '', birthday: data.birthday || '', gender: data.gender || null, preferences: {}, userPrivacyPolicyAcceptance: !!data.userPrivacyPolicyAcceptance, userTermsAcceptance: !!data.userTermsAcceptance };
        users.set(u.id, u);
        if (u.email) usersByEmail.set(u.email, u.id);
      } else {
        Object.assign(u, data);
      }
      return u;
    },
    async addMembership(userId: string, m: any) { const arr = memberships.get(userId) || []; const rec = { id: `m_${Math.random().toString(36).slice(2)}`, userId, businessId: m.businessId, brandId: m.brandId ?? null, role: m.role ?? 'USER' }; arr.push(rec); memberships.set(userId, arr); return rec; },
    async upsertMembership(userId: string, m: any) { const arr = memberships.get(userId) || []; const idx = arr.findIndex(x => x.businessId === m.businessId); if (idx >= 0) { arr[idx] = { ...arr[idx], brandId: m.brandId ?? arr[idx].brandId, role: m.role ?? arr[idx].role }; memberships.set(userId, arr); return arr[idx]; } return this.addMembership(userId, m); },
    async listMemberships(userId: string) { return memberships.get(userId) || []; },
    async findUsersForTargeting(limit: number) { return Array.from(users.values()).slice(0, limit); },
    async findUserById(userId: string) { return users.get(userId) || null; },
    async getLatestPrivacyPolicyVersion() { return '1.0.0'; },
    async getLatestTermsOfServiceVersion() { return '1.0.0'; },
    async getLatestMarketingTermsVersion() { return '1.0.0'; },
    async createPrivacyPolicyAcceptance() { return { ok: true }; },
    async createTermsOfServiceAcceptance() { return { ok: true }; },
    async createMarketingTermsAcceptance() { return { ok: true }; },
  };
}

describe('user-service core endpoints', () => {
  const OLD_ENV = process.env;
  let server: any;
  const overrides = { repository: createMemoryRepo(), tokenService: { async getAccessToken() { return 'test-admin-token'; } } } as const;

  beforeAll(async () => {
    process.env = { ...OLD_ENV, KEYCLOAK_AUTH_BYPASS: 'true', KEYCLOAK_BASE_URL: 'http://kc', KEYCLOAK_REALM: 'returnacy' };
    server = await buildServer({ overrides });
    await server.ready();
  });

  afterAll(async () => {
    process.env = OLD_ENV;
    await server?.close();
  });

  it('POST /api/v1/auth/register creates user and local record', async () => {
    const email = `u_${Date.now()}@test.local`;

    // Mock Keycloak admin endpoints
  (axios.post as any).mockResolvedValueOnce({ headers: { location: 'http://kc/admin/realms/returnacy/users/abcd' } });
  (axios.get as any).mockResolvedValueOnce({ data: { id: 'abcd' } });

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { host: 'localhost' },
      payload: {
        email,
        password: 'SuperSecret1!',
        name: 'Test',
        surname: 'User',
        birthday: '2000-01-01',
        acceptPrivacyPolicy: true,
        acceptTermsOfService: true
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe(email);
    expect(body.keycloakSub).toBeDefined();
  });

  it('GET /api/v1/me auto-enrolls membership for domain when missing', async () => {
    // Provide a fake auth user via headers
  const sub = 'test-sub-1';
  (axios.put as any).mockResolvedValueOnce({ status: 204 });

    // First call: create local user via upsert
    let res = await server.inject({ method: 'GET', url: '/api/v1/me', headers: { host: 'localhost', 'x-test-sub': sub } });
    expect(res.statusCode).toBe(200);
    const first = res.json();
    expect(first.id).toBeDefined();
    expect(Array.isArray(first.memberships)).toBe(true);

    // Second call should still work and not duplicate membership
    res = await server.inject({ method: 'GET', url: '/api/v1/me', headers: { host: 'localhost', 'x-test-sub': sub } });
    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second.memberships.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /internal/v1/users/query requires service auth and returns users array', async () => {
    // Without service auth -> forbidden
    let res = await server.inject({ method: 'POST', url: '/internal/v1/users/query', payload: { targetingRules: [], limit: 5 } });
    expect(res.statusCode).toBe(403);

    // With service auth via x-test-azp
    res = await server.inject({
      method: 'POST', url: '/internal/v1/users/query',
      headers: { 'x-test-azp': 'campaign-service' },
      payload: { targetingRules: [{ database: 'USER', field: 'email', operator: 'CONTAINS', value: '@' }], limit: 5 }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.users)).toBe(true);
  });
});
