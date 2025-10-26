import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type DomainMapping = Record<string, { brandId: string | null; businessId: string }>;

let cache: DomainMapping | null = null;

export function loadDomainMapping(): DomainMapping {
  if (cache) return cache;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Try multiple fallback locations to survive different build layouts
  const candidates: string[] = [];
  if (process.env.DOMAIN_MAPPING_FILE) candidates.push(process.env.DOMAIN_MAPPING_FILE);
  // dist/src/utils -> dist/domain-mapping.json
  candidates.push(path.resolve(__dirname, '../domain-mapping.json'));
  // dist/src/utils -> server root copy
  candidates.push(path.resolve(__dirname, '../../domain-mapping.json'));
  // common absolute path inside container image
  candidates.push('/app/server/domain-mapping.json');
  const filePath = candidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (!filePath) return {} as DomainMapping;
  const raw = fs.readFileSync(filePath, 'utf-8');
  cache = JSON.parse(raw);
  return cache!;
}

export function resolveDomain(host?: string): { brandId: string | null; businessId: string } | null {
  if (!host) return null;
  const map = loadDomainMapping();
  const hostname: string = (host as string).toLowerCase().split(':')[0] ?? '';
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
      if (hostnameOnly) hostCandidates.push(hostnameOnly);
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

  // Fallback to explicit configuration if mapping is missing or does not contain the business
  const fallback = process.env.BUSINESS_SERVICE_URL;
  return fallback ? fallback.replace(/\/+$/u, '') : null;
}
