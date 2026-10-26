import axios from 'axios';
import type { FastifyBaseLogger } from 'fastify';

// messaging-service answers POST /api/v1/messages with 202 { messageId }.
// Anything else means the email was not queued — including a 3xx: for months
// the messaging host was a DNS URL-forward answering 301 → returnacy.app, axios
// followed it to a 200 HTML page and every email counted as sent.
const TIMEOUT_MS = 10_000;

export type MessagingEmail = {
  recipientId: string;
  idempotencyKey: string;
  payload: {
    subject: string;
    bodyHtml: string;
    bodyText: string;
    from: string;
    to: { email: string; name: string };
  };
};

function snippet(data: unknown): string {
  if (data === undefined || data === null) return '';
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return text.slice(0, 200);
}

/** Queues one email on messaging-service; throws unless it was really accepted. */
export async function sendMessagingEmail(
  messagingUrl: string,
  accessToken: string,
  email: MessagingEmail,
  log: FastifyBaseLogger,
): Promise<{ messageId: string }> {
  const url = `${messagingUrl}/api/v1/messages`;
  let status: number | undefined;
  let data: unknown;
  try {
    const res = await axios.post(url, {
      campaignId: null,
      recipientId: email.recipientId,
      idempotencyKey: email.idempotencyKey,
      channel: 'EMAIL',
      scheduledAt: null,
      payload: email.payload,
      maxAttempts: 1
    }, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      maxRedirects: 0,
      timeout: TIMEOUT_MS,
      responseType: 'json',
      validateStatus: (s) => s >= 200 && s < 300,
    });
    status = res.status;
    data = res.data;
  } catch (err: any) {
    status = err?.response?.status;
    log.error(
      { url, status, code: err?.code, body: snippet(err?.response?.data) },
      'messaging-service did not accept the email'
    );
    throw new Error(`MESSAGING_SEND_FAILED: ${status ?? err?.code ?? 'no response'}`);
  }

  const messageId = (data as any)?.messageId;
  if (typeof messageId !== 'string' || !messageId) {
    log.error({ url, status, body: snippet(data) }, 'messaging-service answered without a messageId');
    throw new Error(`MESSAGING_SEND_FAILED: unexpected response (${status})`);
  }
  return { messageId };
}
