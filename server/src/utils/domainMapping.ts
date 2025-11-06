import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { TokenService } from '../classes/tokenService.js';

export type DomainMapping = Record<string, { brandId: string | null; businessId: string | null }>;

let cache: DomainMapping | null = null;

export function loadDomainMapping(): DomainMapping {
  // Deprecated local loader: retained for dev fallback only
  if (cache) return cache;
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const candidates: string[] = [];
    if (process.env.DOMAIN_MAPPING_FILE) candidates.push(process.env.DOMAIN_MAPPING_FILE);
    candidates.push(path.resolve(__dirname, '../domain-mapping.json'));
    candidates.push(path.resolve(__dirname, '../../domain-mapping.json'));
    candidates.push('/app/server/domain-mapping.json');
    const filePath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (!filePath) return {} as DomainMapping;
    const raw = fs.readFileSync(filePath, 'utf-8');
    cache = JSON.parse(raw);
    return cache!;
  } catch {
    return {} as any;
  }
}

async function getServiceHeaders(): Promise<Record<string, string>> {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL
    || ((process.env.KEYCLOAK_BASE_URL && process.env.KEYCLOAK_REALM)
      ? `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`
      : '');
  const clientId = process.env.KEYCLOAK_CLIENT_ID || '';
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET || '';
  if (!tokenUrl || !clientId || !clientSecret) return {};
  try {
    const ts = new TokenService({ tokenUrl, clientId, clientSecret });
    const token = await ts.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export function resolveDomain(host?: string): { brandId: string | null; businessId: string | null } | null {
  if (!host) return null;
  const serviceUrl = process.env.DOMAIN_MAPPER_URL;
  const hostname: string = (host as string).toLowerCase().split(':')[0] ?? '';
  if (serviceUrl) {
    // Fire-and-forget sync fallback: this is a sync fn; best effort cached approach
    // Caller should prefer the async HTTP helper when possible.
    // Here we fallback to local cache until we refactor callers to async.
    // eslint-disable-next-line no-console
    return cache?.[hostname] ?? null;
  }
  const map = loadDomainMapping();
  return map[hostname] ?? null;
}

function scoreHostPreference(value: string): number {
  const lower = value.toLowerCase();
  let score = 0;
  if (lower.includes('business')) score += 5;
  if (lower.includes('api')) score += 3;
  if (lower.includes('service')) score += 2;
  if (lower.includes('backend')) score += 1;
  if (lower.includes('localhost')) score -= 1;
  return score;
}

function normalizeScheme(scheme?: string | null): string {
  const fallback = process.env.BUSINESS_SERVICE_URL_SCHEME || 'https';
  if (!scheme) return fallback;
  const trimmed = scheme.trim().toLowerCase();
  if (!trimmed) return fallback;
  const isValid = /^[a-z][a-z0-9+\-.]*$/.test(trimmed);
  return isValid ? trimmed : fallback;
}

function toCandidateUrl(raw: string, scheme: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/u, '');
  }
  const sanitized = trimmed.replace(/^\/+/, '').replace(/\/+$/u, '');
  return `${scheme}://${sanitized}`;
}

export function resolveBusinessServiceUrl(options: { businessId?: string | null; host?: string | null; scheme?: string | null } = {}): string | null {
  const map = loadDomainMapping();
  const scheme = normalizeScheme(options.scheme);

  const hostCandidates: string[] = [];

  if (options.host) {
    const rawHost = String(options.host).split(',')[0]?.trim() ?? '';
    if (rawHost) {
      const hostnameOnly = rawHost.toLowerCase().split(':')[0] ?? rawHost.toLowerCase();
      if (hostnameOnly && map[hostnameOnly]) hostCandidates.push(hostnameOnly);
    }
  }

  if (options.businessId) {
    for (const [domain, info] of Object.entries(map)) {
      if (info?.businessId === options.businessId && !hostCandidates.includes(domain)) {
        hostCandidates.push(domain);
      }
    }
  }

  const ranked = hostCandidates
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => ({ candidate, score: scoreHostPreference(candidate) }))
    .sort((a, b) => b.score - a.score);

  for (const { candidate } of ranked) {
    const url = toCandidateUrl(candidate, scheme);
    if (url) return url;
  }

  // Prefer domain-mapper-service if available
  const mapper = process.env.DOMAIN_MAPPER_URL;
  if (mapper && options.businessId) {
    // Note: this is sync; we will do a naive cached attempt first
    // then caller can use dedicated async client for strict behavior.
  }
  const fallback = process.env.BUSINESS_SERVICE_URL;
  return fallback ? fallback.replace(/\/+$/u, '') : null;
}

// Async helpers preferred by call sites that can await
export async function fetchBusinessServiceUrl(businessId: string, scheme?: string): Promise<string | null> {
  const mapper = process.env.DOMAIN_MAPPER_URL;
  if (!mapper) return resolveBusinessServiceUrl({ businessId, scheme: scheme ?? null });
  try {
    const headers = await getServiceHeaders();
    const res = await axios.get(`${mapper.replace(/\/$/, '')}/api/v1/business/${encodeURIComponent(businessId)}` , { headers });
    const url = res.data?.url || res.data?.host;
    if (typeof url === 'string' && url) return url;
  } catch {
    // ignore, fallback below
  }
  return resolveBusinessServiceUrl({ businessId, scheme: scheme ?? null });
}

export async function fetchDomainInfoByHost(host: string): Promise<{ brandId: string | null; businessId: string | null } | null> {
  const mapper = process.env.DOMAIN_MAPPER_URL;
  if (!mapper) return resolveDomain(host);
  try {
    const headers = await getServiceHeaders();
  const res = await axios.get(`${mapper.replace(/\/$/, '')}/api/v1/resolve`, { params: { host }, headers });
  const brandId = res.data?.brandId ?? null;
  const businessId = res.data?.businessId ?? null;
  if (brandId || businessId) return { brandId, businessId };
  } catch {
    // ignore
  }
  return resolveDomain(host);
}
