import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

// domain-mapper is network-bound; mock it so each test decides which brand a
// host belongs to.
vi.mock('@/utils/domainMapping.js', () => ({
  resolveDomain: vi.fn(),
  resolveDomainFromRequest: vi.fn(),
  fetchDomainBusinesses: vi.fn(),
  fetchBusinessServiceUrl: vi.fn(),
  resolveBusinessServiceUrl: vi.fn(),
  fetchDomainInfoByHost: vi.fn(),
}));

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  return { ...actual, default: { ...actual.default, post: vi.fn(), get: vi.fn(), put: vi.fn() } };
});

import axios from 'axios';
import { resolveDomain } from '@/utils/domainMapping.js';
import { _resetSelfIssuedCache } from '@/utils/selfIssuedJwt.js';
import { postVerifyEmailService } from '@/modules/api/v1/auth/post.verifyEmail.service.js';
import { buildServer } from '../src/appBuilder.js';

// The env vars are single-valued on a service every brand shares: they name
// Che Pizza, the first brand onboarded.
const CHE_HOST = 'fidelity.chepizzadasalva.it';
const CHE_BRAND = '385d4ebb-4c4b-46e9-8701-0d71bfd7ce47';
const CHE_VERIFY_URL = `https://${CHE_HOST}/email-verifications`;

const SUDEST_HOST = 'sudest.returnacy.app';
const SUDEST_BRAND = 'd99f0f54-3367-4a7e-a3ab-67564c805e46';
const SUDEST_BIZ = 'eb48c067-e914-4532-bd55-bd08766ac0a0';

const TOKEN = 'verify-token-abc';

const DOMAINS: Record<string, any> = {
  [CHE_HOST]: { brandId: CHE_BRAND, businessId: 'af941888-ec4c-458e-b905-21673241af3e', host: CHE_HOST, service: 'frontend-spa', label: 'chepizzadasalva', url: `https://${CHE_HOST}` },
  [SUDEST_HOST]: { brandId: SUDEST_BRAND, businessId: SUDEST_BIZ, host: SUDEST_HOST, service: 'frontend-spa', label: 'sudest', url: `https://${SUDEST_HOST}` },
};

function createRepo() {
  const users: any[] = [];
  return {
    _users: users,
    async healthCheck() { return { ok: true as const }; },
    async findUserByKeycloakSub(sub: string) { return users.find((u) => u.keycloakSub === sub) ?? null; },
    async findUserByEmail(email: string) { return users.find((u) => u.email === email) ?? null; },
    async findUserByGoogleSub() { return null; },
    async createUserWithMembership(sub: string, data: any) {
      const user = { id: `u_${users.length + 1}`, keycloakSub: sub, email: data.email, name: data.name, surname: data.surname };
      users.push(user);
      return user;
    },
    async listMemberships() { return []; },
    async getLatestPrivacyPolicyVersion() { return '1.0.0'; },
    async getLatestTermsOfServiceVersion() { return '1.0.0'; },
    async getLatestMarketingTermsVersion() { return '1.0.0'; },
    async createPrivacyPolicyAcceptance() { return { ok: true }; },
    async createTermsOfServiceAcceptance() { return { ok: true }; },
    async createMarketingTermsAcceptance() { return { ok: true }; },
    async createEmailVerificationToken(userId: string) { return { id: 'tok_1', token: TOKEN, userId }; },
  };
}

/** The single message the service handed to messaging-service. */
function sentMessage() {
  const call = vi.mocked(axios.post).mock.calls.find(([url]) => String(url).includes('/api/v1/messages'));
  expect(call, 'no message was sent to messaging-service').toBeDefined();
  return (call![1] as any).payload as { subject: string; bodyHtml: string; bodyText: string };
}

describe('verification email is addressed to the brand the user signed up on', () => {
  const OLD_ENV = process.env;
  let server: any;
  let repo: ReturnType<typeof createRepo>;
  let emailSeq = 0;

  const payload = () => ({
    email: `signup_${++emailSeq}@test.local`,
    password: 'SuperSecret1!',
    name: 'Test',
    surname: 'User',
    birthday: '2000-01-01',
    acceptPrivacyPolicy: true,
    acceptTermsOfService: true,
  });

  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    process.env = {
      ...OLD_ENV,
      KEYCLOAK_AUTH_BYPASS: 'true',
      JWT_PRIVATE_KEY: privateKey,
      JWT_PUBLIC_KEY: publicKey,
      JWT_KID: 'test-kid-1',
      JWT_ISSUER: 'https://test.user-service.local',
      MESSAGING_SERVICE_URL: 'http://messaging.test',
      FRONTEND_VERIFY_EMAIL_URL: CHE_VERIFY_URL,
      FRONTEND_BASE_URL: `https://${CHE_HOST}`,
    };
    delete process.env.BUSINESS_NAME;
    _resetSelfIssuedCache();
    repo = createRepo();
    server = await buildServer({
      overrides: { repository: repo as any, tokenService: { async getAccessToken() { return 't'; } } },
    });
    await server.ready();
  });

  afterAll(async () => {
    process.env = OLD_ENV;
    await server?.close();
  });

  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.post).mockResolvedValue({ status: 202, data: { messageId: 'msg_1' } } as any);
    vi.mocked(resolveDomain).mockImplementation(async (host?: any) => DOMAINS[String(host)] ?? null);
  });

  it('links a Sud Est signup to the Sud Est SPA', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { host: SUDEST_HOST }, payload: payload() });
    expect(res.statusCode).toBe(200);

    const message = sentMessage();
    expect(message.bodyText).toContain(`https://${SUDEST_HOST}/email-verifications?token=${TOKEN}`);
    expect(message.bodyHtml).toContain(`https://${SUDEST_HOST}/email-verifications?token=${TOKEN}`);
    expect(message.bodyText).not.toContain(CHE_HOST);
    expect(message.bodyHtml).not.toContain(CHE_HOST);
  });

  it('names the brand in the subject instead of its uuid', async () => {
    await server.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { host: SUDEST_HOST }, payload: payload() });

    const message = sentMessage();
    expect(message.subject).toBe('Verifica il tuo indirizzo email - sudest');
    expect(message.subject).not.toContain(SUDEST_BRAND);
  });

  it('leaves a Che Pizza signup byte-identical to what the env vars produce today', async () => {
    await server.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { host: CHE_HOST }, payload: payload() });

    const message = sentMessage();
    // Exactly what the pre-fix code built: `${FRONTEND_VERIFY_EMAIL_URL}?token=${encodeURIComponent(token)}`
    expect(message.bodyText).toContain(`${CHE_VERIFY_URL}?token=${encodeURIComponent(TOKEN)}`);
    expect(message.subject).not.toContain(CHE_BRAND);
  });

  it('resolves the brand from the origin header when the host header is the api', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { host: 'user.returnacy.app', origin: `https://${SUDEST_HOST}` },
      payload: payload(),
    });

    expect(sentMessage().bodyText).toContain(`https://${SUDEST_HOST}/email-verifications?token=${TOKEN}`);
  });
});

describe('resent verification email (POST /auth/verify-email)', () => {
  const OLD_ENV = process.env;

  const request = (host: string, body: Record<string, unknown>) => ({
    auth: { sub: 'sub-1' },
    body,
    headers: { host },
    server: {
      repository: {
        async findUserByKeycloakSub() { return { id: 'u_1', email: 'cliente@test.local', name: 'Test', surname: 'User' }; },
        async createEmailVerificationToken() { return { id: 'tok_1', token: TOKEN }; },
      },
      keycloakTokenService: { async getAccessToken() { return 't'; } },
    },
    log: { error: vi.fn(), warn: vi.fn() },
  }) as any;

  beforeAll(() => {
    process.env = {
      ...OLD_ENV,
      MESSAGING_SERVICE_URL: 'http://messaging.test',
      FRONTEND_VERIFY_EMAIL_URL: CHE_VERIFY_URL,
      FRONTEND_BASE_URL: `https://${CHE_HOST}`,
    };
    delete process.env.BUSINESS_NAME;
  });

  afterAll(() => { process.env = OLD_ENV; });

  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.post).mockResolvedValue({ status: 202, data: { messageId: 'msg_1' } } as any);
    vi.mocked(resolveDomain).mockImplementation(async (host?: any) => DOMAINS[String(host)] ?? null);
  });

  it('sends a Sud Est user to the Sud Est verification page', async () => {
    const res = await postVerifyEmailService(request(SUDEST_HOST, {}));

    expect(res.statusCode).toBe(200);
    const message = sentMessage();
    expect(message.bodyText).toContain(`https://${SUDEST_HOST}/email-verifications?token=${TOKEN}`);
    expect(message.subject).toBe('Verifica il tuo indirizzo email - sudest');
  });

  it('keeps the verification page path when the SPA sends its bare origin as redirectUri', async () => {
    await postVerifyEmailService(request(SUDEST_HOST, { redirectUri: `https://${SUDEST_HOST}` }));

    expect(sentMessage().bodyText).toContain(`https://${SUDEST_HOST}/email-verifications?token=${TOKEN}`);
  });

  it('still uses the configured url when the host resolves to no brand', async () => {
    const res = await postVerifyEmailService(request('unmapped.test', {}));

    expect(res.statusCode).toBe(200);
    expect(sentMessage().bodyText).toContain(`${CHE_VERIFY_URL}?token=${TOKEN}`);
  });
});
