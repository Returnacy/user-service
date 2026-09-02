/**
 * Brand-aware verification emails.
 *
 * user-service is shared by every Returnacy brand, but FRONTEND_VERIFY_EMAIL_URL
 * / FRONTEND_BASE_URL / BUSINESS_NAME are single-valued on it. A customer who
 * signed up on Sud Est was therefore emailed a link to Che Pizza's SPA, and a
 * subject line carrying the brand's raw UUID (the old fallback was
 * `BUSINESS_NAME || domain.brandId`).
 *
 * So both are resolved per request from the domain-mapper, the same way
 * buildDomainResetBase already resolves the password-reset link:
 *   link: mapper-resolved host → FRONTEND_VERIFY_EMAIL_URL → FRONTEND_BASE_URL
 *   name: BUSINESS_NAME → mapper label → resolved SPA host → 'la tua attività'
 * An id is never shown.
 */
import type { DomainResolution } from './domainMapping.js';
import { normalizeAbsoluteUrl } from '@/modules/api/v1/auth/post.forgotPassword.service.js';

type Env = Record<string, string | undefined>;

const DEFAULT_VERIFY_PATH = '/verify-email';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which page of the SPA the link points at. Taken from FRONTEND_VERIFY_EMAIL_URL
 * when it is set, so swapping in a brand's host leaves the rest of the link
 * exactly as it is today for the brand that env var was configured for.
 */
export function verifyEmailPath(env: Env = process.env): string {
  const configured = normalizeAbsoluteUrl(env.FRONTEND_VERIFY_EMAIL_URL || null);
  if (configured) {
    try {
      const { pathname } = new URL(configured);
      if (pathname && pathname !== '/') return pathname;
    } catch {
      // fall through to the default
    }
  }
  return DEFAULT_VERIFY_PATH;
}

/** The verification page on the host the request itself resolved to. */
export function buildDomainVerifyBase(domain?: DomainResolution | null, env: Env = process.env): string | null {
  if (!domain) return null;
  const source = domain.url || domain.host;
  if (!source) return null;
  return normalizeAbsoluteUrl(source, verifyEmailPath(env));
}

/** Base URL of the verification page for this request's brand, or null. */
export function resolveVerifyEmailBase(domain?: DomainResolution | null, env: Env = process.env): string | null {
  return buildDomainVerifyBase(domain, env)
    ?? normalizeAbsoluteUrl(env.FRONTEND_VERIFY_EMAIL_URL || null)
    ?? normalizeAbsoluteUrl(env.FRONTEND_BASE_URL || null, DEFAULT_VERIFY_PATH);
}

/** What to call the business in the subject and body. Never an id. */
export function resolveBrandName(domain?: DomainResolution | null, env: Env = process.env): string {
  const configured = env.BUSINESS_NAME?.trim();
  if (configured) return configured;
  // The mapper's label is the mapping entry's own name; it falls back to the
  // entry key (e.g. "sudest") when the entry sets no explicit label.
  const label = domain?.label?.trim();
  if (label && !UUID_RE.test(label)) return label;
  const host = domain?.host?.trim();
  if (host && !UUID_RE.test(host)) return host;
  return 'la tua attività';
}
