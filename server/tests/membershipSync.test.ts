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

  it('writes membership to local DB and does not call Keycloak Admin API', async () => {
    const repository = {
      getMembership: vi.fn().mockResolvedValue(null),
      getMembershipByBrand: vi.fn().mockResolvedValue(null),
      upsertMembership: vi.fn().mockResolvedValue(undefined),
    };
    const tokenService = { getAccessToken: vi.fn().mockResolvedValue('kc-admin-token') };

    const domain = {
      brandId: 'd290f1ee-6c54-4b01-90e6-d701748f0851',
      businessId: '80d40072-ce57-4829-ace4-e54dd568bc0e',
      host: 'pizzalonga.example.com',
      service: 'frontend',
      label: 'Pizzalonga',
      url: 'https://pizzalonga.example.com',
    };

    const result = await ensureDomainMembership({
      repository,
      tokenService,
      user: { id: 'internal-user-id', keycloakSub: 'd9a1421b-e39c-482e-b4f9-57e1f8c1b655' },
      domain,
      logger,
    });

    expect(repository.upsertMembership).toHaveBeenCalledWith('internal-user-id', {
      businessId: domain.businessId,
      brandId: domain.brandId,
      role: 'USER',
    });

    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(tokenService.getAccessToken).not.toHaveBeenCalled();

    expect(result).toEqual({ created: true, synced: false, skipped: false });
  });

  it('skips DB write when domain has no brand or business', async () => {
    const repository = {
      getMembership: vi.fn(),
      getMembershipByBrand: vi.fn(),
      upsertMembership: vi.fn(),
    };
    const tokenService = { getAccessToken: vi.fn() };

    const result = await ensureDomainMembership({
      repository,
      tokenService,
      user: { id: 'internal-user-id', keycloakSub: 'sub-1' },
      domain: null,
      logger,
    });

    expect(repository.upsertMembership).not.toHaveBeenCalled();
    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(result).toEqual({ created: false, synced: false, skipped: true });
  });
});
