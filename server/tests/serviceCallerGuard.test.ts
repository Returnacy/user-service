import { describe, it, expect, afterEach } from 'vitest';

import { isServiceCaller } from '@/utils/serviceCallerGuard.js';

const ORIGINAL = process.env.INTERNAL_SERVICE_CLIENTS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_CLIENTS;
  else process.env.INTERNAL_SERVICE_CLIENTS = ORIGINAL;
});

describe('isServiceCaller', () => {
  it('accepts a client id listed in INTERNAL_SERVICE_CLIENTS', () => {
    process.env.INTERNAL_SERVICE_CLIENTS = JSON.stringify({ 'business-service': 'secret' });
    expect(isServiceCaller({ sub: 'business-service' })).toBe(true);
  });

  it('accepts a per-tenant id listed in full', () => {
    process.env.INTERNAL_SERVICE_CLIENTS = JSON.stringify({
      'business-service:chepizza': { secret: 's', brandId: 'brand-chepizza' },
    });
    expect(isServiceCaller({ sub: 'business-service:chepizza' })).toBe(true);
  });

  // The reason this guard was widened: §8.1 mints business-service:<slug> for
  // every new brand, and that id is in no fallback list. Read as a user, /me
  // would upsert a phantom User row keyed by the client id.
  it('accepts a per-tenant id whose base is known, without listing the tenant', () => {
    process.env.INTERNAL_SERVICE_CLIENTS = JSON.stringify({ 'business-service': 'secret' });
    expect(isServiceCaller({ sub: 'business-service:sudest' })).toBe(true);
  });

  it('accepts a per-tenant id on the fallback list when the env var is unusable', () => {
    process.env.INTERNAL_SERVICE_CLIENTS = 'not json';
    expect(isServiceCaller({ sub: 'business-service:sudest' })).toBe(true);
  });

  it('still refuses an unknown service family', () => {
    process.env.INTERNAL_SERVICE_CLIENTS = JSON.stringify({ 'business-service': 'secret' });
    expect(isServiceCaller({ sub: 'attacker-service:sudest' })).toBe(false);
  });

  it('does not treat a person as a service', () => {
    process.env.INTERNAL_SERVICE_CLIENTS = JSON.stringify({ 'business-service': 'secret' });
    expect(isServiceCaller({ sub: '9f1c5f8e-1c3b-4a0e-9a2f-7c9d3b6f1a44' })).toBe(false);
    expect(isServiceCaller({ sub: '' })).toBe(false);
    expect(isServiceCaller(null)).toBe(false);
    expect(isServiceCaller(undefined)).toBe(false);
  });
});
