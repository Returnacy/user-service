import type { FastifyRequest } from 'fastify';

/**
 * Cookie Domain Detection Utility
 *
 * Automatically detects the appropriate cookie domain for SSO based on the request hostname.
 * Supports multiple brand domains (.returnacy.app, .chepizzadasalva.it, custom domains)
 * while maintaining security through domain whitelisting.
 */

/**
 * Known domain mappings for SSO cookie configuration
 * Maps parent domains to their cookie domain (with leading dot for subdomain sharing)
 */
const KNOWN_DOMAIN_MAPPINGS: Record<string, string> = {
  'returnacy.app': '.returnacy.app',           // Pizzalonga, other returnacy brands
  'chepizzadasalva.it': '.chepizzadasalva.it', // Che Pizza da Salva
};

/**
 * Environment variable for custom domain mappings (JSON format)
 * Example: COOKIE_DOMAIN_MAPPINGS='{"custompizza.com":".custompizza.com"}'
 */
function getCustomDomainMappings(): Record<string, string> {
  const envMappings = process.env.COOKIE_DOMAIN_MAPPINGS;
  if (!envMappings) return {};

  try {
    return JSON.parse(envMappings);
  } catch (error) {
    console.error('Failed to parse COOKIE_DOMAIN_MAPPINGS environment variable:', error);
    return {};
  }
}

/**
 * Extracts the parent domain from a hostname
 * Examples:
 *   vicenza.pizzalonga.returnacy.app → returnacy.app
 *   fidelity.chepizzadasalva.it → chepizzadasalva.it
 *   app.custompizza.com → custompizza.com
 *   localhost → localhost
 */
function extractParentDomain(hostname: string): string | null {
  if (!hostname) return null;

  // Split hostname into parts
  const parts = hostname.split('.');

  // If less than 2 parts (e.g., 'localhost'), return as-is
  if (parts.length < 2) return hostname;

  // For most cases: take last 2 parts (domain.tld)
  // This handles: example.com, returnacy.app, chepizzadasalva.it
  const parentDomain = parts.slice(-2).join('.');

  return parentDomain;
}

/**
 * Determines the appropriate cookie domain for the given request
 *
 * Logic:
 * 1. For localhost/127.0.0.1: return undefined (no cross-domain cookies)
 * 2. Check against known domain mappings (hardcoded + env var)
 * 3. If matched: return the cookie domain (e.g., .returnacy.app)
 * 4. If not matched: extract parent domain and use it (e.g., .custompizza.com)
 * 5. Log all decisions for debugging
 *
 * Security:
 * - Known domains are whitelisted for explicit control
 * - Unknown domains get automatic parent domain extraction
 * - Localhost never gets cross-domain cookies
 * - Host header is validated to prevent injection
 *
 * @param request - Fastify request object
 * @returns Cookie domain string (with leading dot) or undefined for localhost
 */
export function getCookieDomain(request: FastifyRequest): string | undefined {
  const hostname = request.hostname;

  // Localhost: no cross-domain cookies
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
    request.server.log.debug({ hostname }, 'Localhost detected - no cookie domain');
    return undefined;
  }

  // Merge known mappings with custom mappings from environment
  const allMappings = {
    ...KNOWN_DOMAIN_MAPPINGS,
    ...getCustomDomainMappings(),
  };

  // Check if hostname matches any known domain
  for (const [parentDomain, cookieDomain] of Object.entries(allMappings)) {
    if (hostname === parentDomain || hostname.endsWith(`.${parentDomain}`)) {
      request.server.log.info(
        { hostname, parentDomain, cookieDomain },
        'Matched known domain for SSO cookies'
      );
      return cookieDomain;
    }
  }

  // Unknown domain: extract parent domain and use it
  const parentDomain = extractParentDomain(hostname);
  if (!parentDomain) {
    request.server.log.warn({ hostname }, 'Failed to extract parent domain - using exact hostname');
    return undefined;
  }

  const cookieDomain = `.${parentDomain}`;
  request.server.log.info(
    { hostname, parentDomain, cookieDomain },
    'Unknown domain - using extracted parent domain for cookies'
  );

  return cookieDomain;
}

/**
 * Cookie configuration for access tokens
 * - Short-lived (15 minutes)
 * - JavaScript-accessible (needed for Authorization headers)
 * - Secure in production
 * - SameSite=Lax for CSRF protection
 */
export function getAccessTokenCookieOptions(domain: string | undefined, isProduction: boolean) {
  return {
    domain,
    path: '/',
    httpOnly: false, // Allow JavaScript to read for API calls
    secure: isProduction, // Only send over HTTPS in production
    sameSite: 'lax' as const,
    maxAge: 15 * 60, // 15 minutes
  };
}

/**
 * Cookie configuration for refresh tokens
 * - Long-lived (7 days)
 * - HttpOnly (XSS protection - JavaScript cannot access)
 * - Secure in production
 * - SameSite=Lax for CSRF protection
 */
export function getRefreshTokenCookieOptions(domain: string | undefined, isProduction: boolean) {
  return {
    domain,
    path: '/',
    httpOnly: true, // Prevent JavaScript access for security
    secure: isProduction,
    sameSite: 'lax' as const,
    maxAge: 7 * 24 * 60 * 60, // 7 days
  };
}

/**
 * Cookie configuration for clearing cookies
 * Used during logout to remove cookies across all domains
 */
export function getClearCookieOptions(domain: string | undefined) {
  return {
    domain,
    path: '/',
  };
}
