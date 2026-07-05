import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt } from 'jose';

// Domain resolution is network-bound; mock it so tests control the resolved brand.
vi.mock('@/utils/domainMapping.js', () => ({
  resolveDomainFromRequest: vi.fn(),
}));

import { resolveDomainFromRequest } from '@/utils/domainMapping.js';
import { _resetSelfIssuedCache } from '@/utils/selfIssuedJwt.js';
import { postPmHandoffService } from '@/modules/api/v1/auth/post.pmHandoff.service.js';

const TEST_ISSUER = 'https://test.user-service.local';
const TEST_KID = 'test-kid-pm-1';
const BRAND = 'brand-1';

let testPrivateKeyPem: string;
let testPublicKeyPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  testPrivateKeyPem = privateKey;
  testPublicKeyPem = publicKey;
});

type Membership = { userId: string; brandId: string | null; role: string };

function createRepo() {
  const users = [
    { id: 'u-staff', keycloakSub: 'sub-staff', email: 'staff@x.com', name: 'Sara', surname: 'Staff' },
    { id: 'u-user', keycloakSub: 'sub-user', email: 'user@x.com', name: 'Ugo', surname: 'User' },
  ];
  const memberships: Membership[] = [
    { userId: 'u-staff', brandId: BRAND, role: 'STAFF' },
    { userId: 'u-user', brandId: BRAND, role: 'USER' },
  ];
  return {
    async findUserByKeycloakSub(sub: string) { return users.find((u) => u.keycloakSub === sub) ?? null; },
    async getMembershipByBrand(userId: string, brandId: string) {
      return memberships.find((m) => m.userId === userId && m.brandId === brandId) ?? null;
    },
  };
}

function makeRequest(opts: { sub?: string; repo: any }) {
  return {
    auth: opts.sub ? { sub: opts.sub } : undefined,
    headers: {},
    server: { repository: opts.repo },
    log: { error: () => {}, warn: () => {}, info: () => {} },
  } as any;
}

let repo: ReturnType<typeof createRepo>;

beforeEach(() => {
  process.env.JWT_PRIVATE_KEY = testPrivateKeyPem;
  process.env.JWT_PUBLIC_KEY = testPublicKeyPem;
  process.env.JWT_KID = TEST_KID;
  process.env.JWT_ISSUER = TEST_ISSUER;
  _resetSelfIssuedCache();
  repo = createRepo();
  (resolveDomainFromRequest as any).mockResolvedValue({ brandId: BRAND, businessId: null, host: null, service: null, label: null, url: null });
});

describe('POST /api/v1/auth/pm-handoff', () => {
  it('401 when unauthenticated', async () => {
    const res = await postPmHandoffService(makeRequest({ repo }));
    expect(res.statusCode).toBe(401);
  });

  it('403 when domain resolves to no brand', async () => {
    (resolveDomainFromRequest as any).mockResolvedValueOnce(null);
    const res = await postPmHandoffService(makeRequest({ sub: 'sub-staff', repo }));
    expect(res.statusCode).toBe(403);
  });

  it('403 for a plain USER caller', async () => {
    const res = await postPmHandoffService(makeRequest({ sub: 'sub-user', repo }));
    expect(res.statusCode).toBe(403);
  });

  it('mints a 60s pizzeria-manager token with membershipRole for a STAFF caller', async () => {
    const res = await postPmHandoffService(makeRequest({ sub: 'sub-staff', repo }));
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.expiresIn).toBe(60);
    expect(typeof body.token).toBe('string');

    const decoded = decodeJwt(body.token) as any;
    expect(decoded.aud).toBe('pizzeria-manager');
    expect(decoded.iss).toBe(TEST_ISSUER);
    expect(decoded.sub).toBe('sub-staff');
    expect(decoded.email).toBe('staff@x.com');
    expect(decoded.given_name).toBe('Sara');
    expect(decoded.family_name).toBe('Staff');
    expect(decoded.name).toBe('Sara Staff');
    expect(decoded.membershipRole).toBe('STAFF');
    expect(decoded.exp - decoded.iat).toBe(60);
  });
});
