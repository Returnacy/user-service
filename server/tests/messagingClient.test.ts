import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// domain-mapper is network-bound; mock it so each test decides which brand a
// host belongs to. axios is NOT mocked: the helper talks to a real local server.
vi.mock('@/utils/domainMapping.js', () => ({
  resolveDomain: vi.fn(),
  resolveDomainFromRequest: vi.fn(),
  fetchDomainBusinesses: vi.fn(),
  fetchBusinessServiceUrl: vi.fn(),
  resolveBusinessServiceUrl: vi.fn(),
  fetchDomainInfoByHost: vi.fn(),
}));

import axios, { AxiosError } from 'axios';
import { resolveDomain } from '@/utils/domainMapping.js';
import { sendMessagingEmail, type MessagingEmail } from '@/utils/messagingClient.js';
import { postForgotPasswordService } from '@/modules/api/v1/auth/post.forgotPassword.service.js';

type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

// Stand-in for messaging-service. Each test sets how /api/v1/messages answers;
// /landing is where the old DNS forward sent everyone.
let respond: Responder;
let received: Array<{ path: string; body: any }> = [];
let server: http.Server;
let baseUrl: string;

const HTML_PAGE = `<!doctype html><html><head><title>Returnacy</title></head><body>${'x'.repeat(500)}</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push({ path: req.url || '', body: raw ? JSON.parse(raw) : null });
      if (req.url === '/landing') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HTML_PAGE);
        return;
      }
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
});

const accepted: Responder = (_req, res) => {
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ messageId: 'cmsg_123' }));
};

const redirected: Responder = (_req, res) => {
  res.writeHead(301, { Location: `${baseUrl}/landing`, 'Content-Type': 'text/html' });
  res.end(HTML_PAGE);
};

function fakeLog() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as any;
}

const EMAIL: MessagingEmail = {
  recipientId: 'u_1',
  idempotencyKey: 'reset:u_1:tok_1',
  payload: {
    subject: 'Oggetto',
    bodyHtml: '<p>ciao</p>',
    bodyText: 'ciao',
    from: 'noreply@returnacy.app',
    to: { email: 'cliente@test.local', name: 'Test User' },
  },
};

describe('sendMessagingEmail fails loudly unless messaging-service queued the email', () => {
  it('returns the messageId on 202 { messageId }', async () => {
    respond = accepted;
    const log = fakeLog();

    await expect(sendMessagingEmail(baseUrl, 'svc-token', EMAIL, log)).resolves.toEqual({ messageId: 'cmsg_123' });
    expect(log.error).not.toHaveBeenCalled();
    // Payload unchanged from the pre-helper callers.
    expect(received[0]).toEqual({
      path: '/api/v1/messages',
      body: {
        campaignId: null,
        recipientId: 'u_1',
        idempotencyKey: 'reset:u_1:tok_1',
        channel: 'EMAIL',
        scheduledAt: null,
        payload: EMAIL.payload,
        maxAttempts: 1,
      },
    });
  });

  it('throws on a 301 and does not follow it (the silent DNS forward)', async () => {
    respond = redirected;
    const log = fakeLog();

    await expect(sendMessagingEmail(baseUrl, 'svc-token', EMAIL, log)).rejects.toThrow(/MESSAGING_SEND_FAILED/);
    expect(received.map((r) => r.path)).toEqual(['/api/v1/messages']);
    const [fields] = log.error.mock.calls[0];
    expect(fields.status).toBe(301);
    expect(fields.body).toBe(HTML_PAGE.slice(0, 200));
  });

  it('throws on a 200 HTML page', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML_PAGE);
    };
    const log = fakeLog();

    await expect(sendMessagingEmail(baseUrl, 'svc-token', EMAIL, log)).rejects.toThrow(/MESSAGING_SEND_FAILED/);
    const [fields] = log.error.mock.calls[0];
    expect(fields.status).toBe(200);
    expect(fields.body).toHaveLength(200);
  });

  it('throws on a 2xx JSON body that is not { messageId }', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    await expect(sendMessagingEmail(baseUrl, 'svc-token', EMAIL, fakeLog())).rejects.toThrow(/MESSAGING_SEND_FAILED/);
  });

  it('throws on a 4xx/5xx from messaging-service', async () => {
    respond = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad' }));
    };

    await expect(sendMessagingEmail(baseUrl, 'svc-token', EMAIL, fakeLog())).rejects.toThrow(/400/);
  });

  describe('timeout', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('asks for a 10s timeout with no redirects and throws when it fires', async () => {
      let config: any;
      vi.spyOn(axios, 'post').mockImplementation(async (_url, _body, cfg) => {
        config = cfg;
        throw new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED', cfg as any);
      });
      const log = fakeLog();

      await expect(sendMessagingEmail(baseUrl, 'svc-token', EMAIL, log)).rejects.toThrow(/ECONNABORTED/);
      expect(config.timeout).toBe(10_000);
      expect(config.maxRedirects).toBe(0);
      expect(config.validateStatus(301)).toBe(false);
      expect(config.validateStatus(202)).toBe(true);
      expect(log.error).toHaveBeenCalled();
    });
  });
});

describe('POST /auth/forgot-password', () => {
  const OLD_ENV = process.env;
  const SUDEST_HOST = 'sudest.returnacy.app';
  const KNOWN = 'cliente@test.local';

  const request = (email: string) => ({
    body: { email },
    headers: { host: SUDEST_HOST },
    server: {
      repository: {
        async findUserByEmail(e: string) { return e === KNOWN ? { id: 'u_1', email: KNOWN, name: 'Test', surname: 'User' } : null; },
        async createPasswordResetToken() { return { id: 'tok_1', token: 'reset-token-abc' }; },
      },
      keycloakTokenService: { async getAccessToken() { return 't'; } },
    },
    log: fakeLog(),
  }) as any;

  beforeAll(() => {
    process.env = { ...OLD_ENV, MESSAGING_SERVICE_URL: baseUrl };
    delete process.env.BUSINESS_NAME;
  });

  afterAll(() => { process.env = OLD_ENV; });

  beforeEach(() => {
    vi.mocked(resolveDomain).mockImplementation(async (host?: any) => (String(host) === SUDEST_HOST
      ? { brandId: 'd99f0f54-3367-4a7e-a3ab-67564c805e46', businessId: 'eb48c067-e914-4532-bd55-bd08766ac0a0', host: SUDEST_HOST, service: 'frontend-spa', label: 'sudest', url: `https://${SUDEST_HOST}` }
      : null) as any);
  });

  it('answers an unknown email exactly like a known one, without sending', async () => {
    respond = accepted;
    const req = request('nessuno@test.local');

    const res = await postForgotPasswordService(req);

    expect(res).toEqual({ statusCode: 200, body: { ok: true } });
    expect(received).toHaveLength(0);
    expect(req.log.info).toHaveBeenCalled();
  });

  it('names the brand of the requesting domain in the subject', async () => {
    respond = accepted;

    const res = await postForgotPasswordService(request(KNOWN));

    expect(res).toEqual({ statusCode: 200, body: { ok: true } });
    const sent = received.find((r) => r.path === '/api/v1/messages');
    expect(sent?.body.payload.subject).toBe('Reimposta la tua password - sudest');
    expect(sent?.body.payload.bodyHtml).toContain('sudest');
  });

  it('returns 400 when messaging-service does not accept the email (e.g. a 301)', async () => {
    respond = redirected;
    const req = request(KNOWN);

    const res = await postForgotPasswordService(req);

    expect(res).toEqual({ statusCode: 400, body: { error: 'FORGOT_PASSWORD_FAILED' } });
    expect(JSON.stringify(res.body)).not.toContain('<html');
  });
});
