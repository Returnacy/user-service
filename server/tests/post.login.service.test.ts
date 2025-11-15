import { describe, it, expect } from 'vitest';

import { isAccountNotFullySetupError } from '@/modules/api/v1/auth/post.login.service.js';

describe('isAccountNotFullySetupError', () => {
  it('returns true for invalid_grant errors', () => {
    const err = {
      response: {
        status: 400,
        data: {
          error: 'invalid_grant',
          error_description: 'Account is not fully set up'
        }
      }
    };
    expect(isAccountNotFullySetupError(err)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    const err = {
      response: {
        status: 401,
        data: {
          error: 'invalid_client',
          error_description: 'Client authentication failed'
        }
      }
    };
    expect(isAccountNotFullySetupError(err)).toBe(false);
  });
});
