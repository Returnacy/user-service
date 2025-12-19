import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';

import keycloakTokenPlugin from './plugins/keycloakTokenPlugin.js';
import keycloakAuthPlugin from './plugins/keycloakAuthPlugin.js';
import userAuthPlugin from './plugins/userAuthPlugin.js';

import { healthRoute } from './modules/health/health.route.js';
import { authRoute } from './modules/api/v1/auth/auth.route.js';
import { meRoute } from './modules/api/v1/me/me.route.js';
import { usersRoute } from './modules/api/v1/users/users.route.js';
import { internalUsersRoute } from './modules/internal/v1/users/users.route.js';

type Overrides = {
  repository?: any;
  tokenService?: { getAccessToken(): Promise<string> };
};

type CorsConfig = {
  allowAll: boolean;
  allowedOrigins: Set<string>;
  allowedHeaders: string[];
  exposedHeaders: string[];
  methods: string[];
  maxAge: number;
};

const DEFAULT_ALLOWED_HEADERS = ['authorization', 'content-type', 'user-agent', 'x-requested-with', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'];
const DEFAULT_EXPOSED_HEADERS = ['set-cookie'];
const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DEFAULT_MAX_AGE = 600;

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return [...fallback];
  const tokens = value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return tokens.length > 0 ? tokens : [...fallback];
}

function expandOriginTokens(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed === '*' || trimmed.toLowerCase() === 'null') return [trimmed.toLowerCase()];
  try {
    const url = new URL(trimmed);
    const scheme = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    const port = url.port;
    const tokens = new Set<string>();
    if (port) {
      tokens.add(`${scheme}//${hostname}:${port}`);
      const isDefaultPort = (scheme === 'https:' && port === '443') || (scheme === 'http:' && port === '80');
      if (isDefaultPort) tokens.add(`${scheme}//${hostname}`);
    } else {
      tokens.add(`${scheme}//${hostname}`);
    }
    tokens.add(`${scheme}//${url.host.toLowerCase()}`);
    return Array.from(tokens);
  } catch {
    return [trimmed.replace(/\/+$/u, '').toLowerCase()];
  }
}

function buildCorsConfig(raw?: string | null): CorsConfig {
  const originSource = raw ?? process.env.CORS_ORIGIN ?? '*';
  let allowAll = originSource.trim() === '' || originSource.trim() === '*';
  const allowedOrigins = new Set<string>();
  if (!allowAll) {
    const parts = originSource
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (parts.length === 0) {
      allowAll = true;
    } else {
      for (const token of parts) {
        const expansions = expandOriginTokens(token);
        expansions.forEach((candidate) => allowedOrigins.add(candidate));
      }
    }
  }

  const allowedHeaders = splitCsv(process.env.CORS_ALLOWED_HEADERS, DEFAULT_ALLOWED_HEADERS);
  const exposedHeaders = splitCsv(process.env.CORS_EXPOSED_HEADERS, DEFAULT_EXPOSED_HEADERS);
  const methods = splitCsv(process.env.CORS_METHODS, DEFAULT_METHODS).map((method) => method.toUpperCase());
  const parsedMaxAge = Number(process.env.CORS_MAX_AGE ?? DEFAULT_MAX_AGE);
  const maxAge = Number.isFinite(parsedMaxAge) && parsedMaxAge >= 0 ? parsedMaxAge : DEFAULT_MAX_AGE;

  return {
    allowAll,
    allowedOrigins,
    allowedHeaders,
    exposedHeaders,
    methods,
    maxAge,
  };
}

function isOriginAllowed(origin: string, allowedOrigins: Set<string>): boolean {
  if (allowedOrigins.size === 0) return false;
  const candidates = expandOriginTokens(origin);
  return candidates.some((candidate) => allowedOrigins.has(candidate));
}

export async function buildServer(opts?: { overrides?: Overrides }) {
  const server = Fastify({ logger: true });

  const corsConfig = buildCorsConfig(process.env.CORS_ORIGIN);
  const rejectedOrigins = new Set<string>();

  await server.register(fastifyCors, {
    origin(origin, cb) {
      if (!origin) {
        cb(null, true);
        return;
      }
      if (corsConfig.allowAll || isOriginAllowed(origin, corsConfig.allowedOrigins)) {
        cb(null, true);
        return;
      }
      if (!rejectedOrigins.has(origin)) {
        rejectedOrigins.add(origin);
        server.log.warn({ origin }, 'CORS origin rejected');
      }
      // Do not hard-fail the request. By returning `false` without an error,
      // we simply omit CORS headers so browsers can't read responses via XHR.
      // This avoids turning cross-site navigations / form POSTs (e.g. Google GIS redirect mode)
      // into 500 responses.
      cb(null, false);
    },
    allowedHeaders: corsConfig.allowedHeaders,
    exposedHeaders: corsConfig.exposedHeaders,
    methods: corsConfig.methods,
    credentials: true,
    maxAge: corsConfig.maxAge,
  });

  await server.register(fastifyCookie);
  await server.register(fastifyFormbody);

  // Debug switch: bypass auth + DB and return a fixed response for the CRM users query.
  // If this still results in a 502 upstream, the request likely isn't reaching this service.
  server.addHook('onRequest', async (request, reply) => {
    if (process.env.INTERNAL_USERS_QUERY_MOCK !== '1') return;

    const url = request.raw.url ?? '';
    if (request.method === 'POST' && url.startsWith('/internal/v1/users/query')) {
      const nowIso = new Date().toISOString();
      reply.header('cache-control', 'no-store');
      reply.status(200).send({
        users: [
          {
            id: 'mock-user-1',
            email: 'mock1@example.com',
            phone: '+390000000001',
            firstName: 'Mock',
            lastName: 'UserOne',
            attributes: { birthday: '1990-01-01', stamps: 3, tokens: 0 },
            stats: { validStamps: 3, totalStamps: 3, validCoupons: 0, lastVisit: nowIso },
          },
          {
            id: 'mock-user-2',
            email: 'mock2@example.com',
            phone: '+390000000002',
            firstName: 'Mock',
            lastName: 'UserTwo',
            attributes: { birthday: '1985-12-31', stamps: 10, tokens: 2 },
            stats: { validStamps: 10, totalStamps: 12, validCoupons: 1, lastVisit: nowIso },
          },
        ],
      });
    }
  });

  if (!opts?.overrides?.repository) {
    const { default: prismaRepositoryPlugin } = await import('./plugins/prismaRepositoryPlugin.js');
    await server.register(prismaRepositoryPlugin);
  } else {
    (server as any).repository = opts.overrides.repository;
  }
  if (!opts?.overrides?.tokenService) {
    await server.register(keycloakTokenPlugin);
  } else {
    (server as any).keycloakTokenService = opts.overrides.tokenService;
  }
  await server.register(keycloakAuthPlugin);
  await server.register(userAuthPlugin);

  await server.register(healthRoute);
  await server.register(authRoute, { prefix: '/api/v1/auth' });
  await server.register(meRoute, { prefix: '/api/v1/me' });
  await server.register(usersRoute, { prefix: '/api/v1/users' });
  await server.register(internalUsersRoute, { prefix: '/internal/v1/users' });

  return server;
}
