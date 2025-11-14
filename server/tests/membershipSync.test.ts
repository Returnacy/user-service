import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => {
  const get = vi.fn();
  const put = vi.fn();
  const post = vi.fn();
  return {
    default: { get, put, post },
    get,
    put,
    post,
  };
});

import axios from 'axios';

import { ensureDomainMembership } from '@/utils/membershipSync.js';

const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

describe('ensureDomainMembership', () => {
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
  } as any;

  beforeEach(() => {
    process.env.KEYCLOAK_BASE_URL = 'https://auth.example.com';
    process.env.KEYCLOAK_REALM = 'returnacy';
    vi.clearAllMocks();
  });

  it('preserves Keycloak profile fields when syncing memberships', async () => {
    const repository = {
      getMembership: vi.fn().mockResolvedValue(null),
      getMembershipByBrand: vi.fn().mockResolvedValue(null),
      upsertMembership: vi.fn().mockResolvedValue(undefined),
    };
    const tokenService = { getAccessToken: vi.fn().mockResolvedValue('kc-admin-token') };

    const kcUser = {
      id: 'd9a1421b-e39c-482e-b4f9-57e1f8c1b655',
      username: 'user@example.com',
      email: 'user@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      enabled: true,
      emailVerified: false,
      attributes: {
        memberships: [
          '[{"brandId":"385d4ebb-4c4b-46e9-8701-0d71bfd7ce47","businessId":"af941888-ec4c-458e-b905-21673241af3e","roles":["user"]}]'
        ],
      },
    };

    mockedAxios.get.mockResolvedValue({ data: kcUser });
    mockedAxios.put.mockResolvedValue({ data: {} });

    const domain = {
      brandId: 'd290f1ee-6c54-4b01-90e6-d701748f0851',
      businessId: 'e5f6g7h8-9i0j-1k2l-3m4n-5o6p7q8r9s0t',
      host: 'pizzalonga.example.com',
      service: 'frontend',
      label: 'Pizzalonga',
      url: 'https://pizzalonga.example.com',
    };

    const result = await ensureDomainMembership({
      repository,
      tokenService,
      user: { id: 'internal-user-id', keycloakSub: kcUser.id },
      domain,
      logger,
    });

    expect(repository.upsertMembership).toHaveBeenCalledWith('internal-user-id', {
      businessId: domain.businessId,
      brandId: domain.brandId,
      role: 'USER',
    });

    expect(mockedAxios.put).toHaveBeenCalledTimes(1);
    const [url, payload] = mockedAxios.put.mock.calls[0]!;
    expect(url).toContain(kcUser.id);
    expect(payload).toMatchObject({
      email: kcUser.email,
      firstName: kcUser.firstName,
      lastName: kcUser.lastName,
    });
    expect(payload.attributes?.memberships).toHaveLength(1);
    const membershipsJson = payload.attributes?.memberships?.[0];
    expect(typeof membershipsJson).toBe('string');
    const parsed = JSON.parse(membershipsJson as string);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toMatchObject({
      brandId: domain.brandId,
      businessId: domain.businessId,
      roles: ['user'],
    });

    expect(result).toEqual({ created: true, synced: true, skipped: false });
  });
});
