import { describe, it, expect } from 'vitest';

import { resolveBrandName, resolveVerifyEmailBase, verifyEmailPath } from '@/utils/emailLinks.js';
import type { DomainResolution } from '@/utils/domainMapping.js';

// user-service is shared by every brand, so these single-valued env vars point
// at whichever brand was configured first — Che Pizza.
const CHE_VERIFY_URL = 'https://fidelity.chepizzadasalva.it/email-verifications';
const CHE_BASE_URL = 'https://fidelity.chepizzadasalva.it';

const CHE_BRAND_ID = '385d4ebb-4c4b-46e9-8701-0d71bfd7ce47';
const SUDEST_BRAND_ID = 'd99f0f54-3367-4a7e-a3ab-67564c805e46';

function domain(partial: Partial<DomainResolution>): DomainResolution {
  return { brandId: null, businessId: null, host: null, service: null, label: null, url: null, ...partial };
}

const cheEnv = { FRONTEND_VERIFY_EMAIL_URL: CHE_VERIFY_URL, FRONTEND_BASE_URL: CHE_BASE_URL };

describe('resolveVerifyEmailBase', () => {
  it('sends a new brand to its own SPA, not to the one the env vars name', () => {
    const base = resolveVerifyEmailBase(
      domain({ brandId: SUDEST_BRAND_ID, host: 'sudest.returnacy.app', service: 'frontend-spa' }),
      cheEnv,
    );
    expect(base).toBe('https://sudest.returnacy.app/email-verifications');
  });

  it('uses the absolute url the mapper returns when it has one', () => {
    const base = resolveVerifyEmailBase(
      domain({ host: 'sudest.returnacy.app', url: 'https://sudest.returnacy.app' }),
      cheEnv,
    );
    expect(base).toBe('https://sudest.returnacy.app/email-verifications');
  });

  it('leaves Che Pizza on exactly the link the env var already produces', () => {
    const base = resolveVerifyEmailBase(
      domain({ brandId: CHE_BRAND_ID, host: 'fidelity.chepizzadasalva.it', service: 'frontend-spa' }),
      cheEnv,
    );
    expect(base).toBe(CHE_VERIFY_URL);
  });

  it('falls back to FRONTEND_VERIFY_EMAIL_URL when the host resolves to nothing', () => {
    expect(resolveVerifyEmailBase(null, cheEnv)).toBe(CHE_VERIFY_URL);
  });

  it('falls back to FRONTEND_BASE_URL when there is no verify url', () => {
    expect(resolveVerifyEmailBase(null, { FRONTEND_BASE_URL: CHE_BASE_URL }))
      .toBe('https://fidelity.chepizzadasalva.it/verify-email');
  });

  it('returns null when nothing resolves and nothing is configured', () => {
    expect(resolveVerifyEmailBase(null, {})).toBeNull();
  });
});

describe('verifyEmailPath', () => {
  it('keeps the path the configured verify url uses', () => {
    expect(verifyEmailPath(cheEnv)).toBe('/email-verifications');
  });

  it('defaults to the SPA verification route when nothing is configured', () => {
    expect(verifyEmailPath({})).toBe('/verify-email');
    expect(verifyEmailPath({ FRONTEND_VERIFY_EMAIL_URL: 'https://fidelity.chepizzadasalva.it' })).toBe('/verify-email');
  });
});

describe('resolveBrandName', () => {
  it('never puts a brand id in front of a customer', () => {
    const name = resolveBrandName(domain({ brandId: SUDEST_BRAND_ID, host: 'sudest.returnacy.app', label: 'sudest' }), {});
    expect(name).toBe('sudest');
    expect(name).not.toContain(SUDEST_BRAND_ID);
  });

  it('ignores a label that is itself an id', () => {
    expect(resolveBrandName(domain({ label: SUDEST_BRAND_ID, host: 'sudest.returnacy.app' }), {}))
      .toBe('sudest.returnacy.app');
  });

  it('falls back to the resolved host when the mapper carries no label', () => {
    expect(resolveBrandName(domain({ brandId: SUDEST_BRAND_ID, host: 'sudest.returnacy.app' }), {}))
      .toBe('sudest.returnacy.app');
  });

  it('falls back to a generic name when the host resolves to nothing', () => {
    expect(resolveBrandName(null, {})).toBe('la tua attività');
  });

  it('prefers BUSINESS_NAME when it is configured', () => {
    expect(resolveBrandName(domain({ label: 'sudest' }), { BUSINESS_NAME: 'Sud Est' })).toBe('Sud Est');
  });
});
