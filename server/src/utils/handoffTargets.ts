import type { FastifyBaseLogger } from 'fastify';

import { getInternalServiceClients } from './selfIssuedJwt.js';

/**
 * Configuration of the external brand services a logged-in customer can be
 * handed off to (POST /api/v1/auth/handoff). See docs/SSO-HANDOFF-CONTRACT.md.
 *
 *   HANDOFF_TARGETS={"promo-site":{"audience":"promo-site","brandId":"<uuid>",
 *                    "url":"https://promo.example.com/handoff","roles":["USER"]}}
 *
 * Fail-closed: unset, invalid JSON, or a malformed entry means that target does
 * not exist. One bad entry never voids the others.
 */

export type HandoffTarget = {
  audience: string;
  brandId: string;
  url: string;
  /** null = any role with a membership in the brand. */
  roles: ReadonlySet<string> | null;
};

const KNOWN_ROLES: ReadonlySet<string> = new Set(['USER', 'STAFF', 'MANAGER', 'BRAND_MANAGER', 'ADMIN']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// No ':' and no whitespace: the first-party audience gates widen a candidate on
// the segment before ':', so a colon would only add ways to collide with them.
const AUDIENCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Mirrors tenantGuard's DEFAULT_SERVICE_CLIENT_IDS and serviceCallerGuard's
// FALLBACK_SERVICE_CLIENT_IDS: what the first-party gates accept when their env
// var is unset.
const DEFAULT_SERVICE_CLIENT_IDS = ['campaign-service', 'messaging-service', 'user-service', 'business-service', 'domain-mapper-service'];

function splitList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Every audience (or azp) some first-party verifier accepts. A handoff token
 * goes to a service outside the platform, so it must never be minted for one of
 * these — otherwise a misconfigured target would hand that service a credential
 * it could replay against our own APIs.
 */
export function reservedAudiences(): Set<string> {
  const reserved = [
    'frontend-spa', // default audience of user access tokens (signAccessToken)
    'pizzeria-manager', // audience of /pm-handoff tokens
    ...DEFAULT_SERVICE_CLIENT_IDS,
    ...splitList(process.env.JWT_ISSUER), // audience of refresh tokens
    ...splitList(process.env.KEYCLOAK_AUDIENCE),
    ...splitList(process.env.KEYCLOAK_ALLOWED_AUDIENCES),
    ...splitList(process.env.KEYCLOAK_SERVICE_AUDIENCE),
    ...splitList(process.env.KEYCLOAK_CLIENT_ID),
    ...splitList(process.env.SERVICE_CLIENT_ID),
    ...Object.keys(getInternalServiceClients() ?? {}),
  ];
  return new Set(reserved.map((s) => s.toLowerCase()));
}

/** Same widening as tenantGuard's matchesAllowedService: full id, or the segment before ':'. */
function isReserved(audience: string, reserved: Set<string>): boolean {
  const candidate = audience.toLowerCase();
  if (reserved.has(candidate)) return true;
  for (const id of reserved) {
    const base = id.split(':')[0] ?? '';
    if (base.length > 0 && base === candidate) return true;
  }
  return false;
}

function isAllowedUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && url.hostname === 'localhost';
}

function parseEntry(value: unknown, reserved: Set<string>): { target: HandoffTarget } | { reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: 'entry is not an object' };
  const { audience, brandId, url, roles } = value as Record<string, unknown>;

  if (typeof audience !== 'string' || !AUDIENCE_RE.test(audience)) return { reason: 'invalid audience' };
  if (isReserved(audience, reserved)) return { reason: `audience "${audience}" is reserved for first-party services` };
  if (typeof brandId !== 'string' || !UUID_RE.test(brandId)) return { reason: 'brandId is not a UUID' };
  if (!isAllowedUrl(url)) return { reason: 'url must be https (http only for localhost)' };

  let roleSet: Set<string> | null = null;
  if (roles !== undefined) {
    if (!Array.isArray(roles) || roles.length === 0) return { reason: 'roles must be a non-empty array' };
    roleSet = new Set();
    for (const role of roles) {
      if (typeof role !== 'string' || !KNOWN_ROLES.has(role)) return { reason: `unknown role ${JSON.stringify(role)}` };
      roleSet.add(role);
    }
  }

  return { target: { audience, brandId, url, roles: roleSet } };
}

let cachedTargets: Map<string, HandoffTarget> | null = null;

/**
 * Parsed HANDOFF_TARGETS, parsed once per process. Invalid entries are dropped
 * with a warning naming the key and the reason (the config holds no secrets).
 */
export function getHandoffTargets(log?: Pick<FastifyBaseLogger, 'warn' | 'info'>): Map<string, HandoffTarget> {
  if (cachedTargets) return cachedTargets;
  const targets = new Map<string, HandoffTarget>();
  cachedTargets = targets;

  const raw = process.env.HANDOFF_TARGETS;
  if (!raw || raw.trim().length === 0) return targets;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log?.warn('[handoff] HANDOFF_TARGETS is not valid JSON; no handoff target is enabled');
    return targets;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log?.warn('[handoff] HANDOFF_TARGETS must be a JSON object keyed by target; no handoff target is enabled');
    return targets;
  }

  const reserved = reservedAudiences();
  for (const [key, value] of Object.entries(parsed)) {
    const result = parseEntry(value, reserved);
    if ('reason' in result) {
      log?.warn({ target: key, reason: result.reason }, '[handoff] HANDOFF_TARGETS entry ignored');
      continue;
    }
    targets.set(key, result.target);
  }
  log?.info({ targets: Array.from(targets.keys()) }, '[handoff] HANDOFF_TARGETS loaded');
  return targets;
}

/** Test-only: forget the parsed configuration. */
export function _resetHandoffTargetsCache(): void {
  cachedTargets = null;
}
