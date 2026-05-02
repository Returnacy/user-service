import axios from 'axios';
import type { FastifyBaseLogger } from 'fastify';

import type { DomainResolution } from './domainMapping.js';
import { buildMembershipAttribute, ensureMembershipEntry, normalizeMemberships } from './memberships.js';
import { buildUserAttributeUpdatePayload } from './keycloak.js';

type TokenService = { getAccessToken(opts?: { mode?: 'service' | 'admin'; scope?: string }): Promise<string> };

type EnsureMembershipOptions = {
  repository: any;
  tokenService: TokenService;
  user: { id: string; keycloakSub: string };
  domain: DomainResolution | null;
  logger: FastifyBaseLogger;
  role?: string;
  extraAttributes?: Record<string, unknown>;
};

type EnsureMembershipResult = {
  created: boolean;
  synced: boolean;
  skipped: boolean;
};

function normalizeRole(input?: string): { dbRole: string; attributeRoles: string[] } {
  const defaultRole = 'USER';
  if (!input) return { dbRole: defaultRole, attributeRoles: ['user'] };
  const trimmed = input.trim();
  if (!trimmed) return { dbRole: defaultRole, attributeRoles: ['user'] };
  return { dbRole: trimmed.toUpperCase(), attributeRoles: [trimmed.toLowerCase()] };
}

export async function ensureDomainMembership(options: EnsureMembershipOptions): Promise<EnsureMembershipResult> {
  const { repository, tokenService, user, domain, logger } = options;
  const result: EnsureMembershipResult = { created: false, synced: false, skipped: false };

  const hasMembershipTarget = Boolean(domain && (domain.businessId || domain.brandId));
  if (!hasMembershipTarget) result.skipped = true;

  const businessId = hasMembershipTarget ? domain!.businessId ?? null : null;
  const brandId = hasMembershipTarget ? domain!.brandId ?? null : null;
  const { dbRole, attributeRoles } = normalizeRole(options.role);

  let membershipExists = false;
  if (hasMembershipTarget) {
    try {
      if (businessId && typeof repository?.getMembership === 'function') {
        const existing = await repository.getMembership(user.id, businessId);
        membershipExists = Boolean(existing);
      }
      if (!membershipExists && brandId && typeof repository?.getMembershipByBrand === 'function') {
        const existingBrand = await repository.getMembershipByBrand(user.id, brandId);
        membershipExists = Boolean(existingBrand);
      }
    } catch (err) {
      logger?.warn?.({ err, businessId, brandId }, 'Failed to check user membership');
    }

    if (!membershipExists) {
      try {
        if (typeof repository?.upsertMembership === 'function') {
          await repository.upsertMembership(user.id, { businessId, brandId, role: dbRole });
        } else if (typeof repository?.addMembership === 'function') {
          await repository.addMembership(user.id, { businessId, brandId, role: dbRole });
        } else {
          throw new Error('REPOSITORY_NO_MEMBERSHIP_HELPER');
        }
        result.created = true;
      } catch (err) {
        logger?.error?.({ err, businessId, brandId }, 'Failed to create membership for user');
        throw err;
      }
    }
  }

  return result;
}
