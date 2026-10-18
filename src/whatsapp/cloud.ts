import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage as HttpRequest, type Server } from 'node:http';
import { z } from 'zod';
import { fetchWithRetry, HttpError, categorize } from '../http.js';
import type { Logger } from '../logger.js';
import type { IncomingMessage, Outgoing } from '../types.js';

/**
 * Official WhatsApp Business Platform (Cloud API) transport for 1:1 chats.
 * Inbound: Meta webhook (GET verification handshake, POST events signed with X-Hub-Signature-256).
 * Outbound: POST /{phone-number-id}/messages, PDFs uploaded via /{phone-number-id}/media.
 */
export interface CloudConfig {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphVersion: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_BODY = 1024 * 1024;

export function verifySignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const WebhookBody = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z
                .object({
                  metadata: z.object({ phone_number_id: z.string() }).partial().optional(),
                  messages: z
                    .array(
                      z.object({
                        id: z.string(),
                        from: z.string(),
                        timestamp: z.coerce.number().optional(),
                        type: z.string(),
                        text: z.object({ body: z.string() }).optional(),
                        context: z.object({ id: z.string().optional() }).optional(),
                      }),
                    )
                    .optional(),
                })
                .passthrough(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

/** Extracts text messages addressed to our phone number. Status updates and non-text types are dropped. */
export function parseWebhook(json: unknown, phoneNumberId: string): IncomingMessage[] {
  const parsed = WebhookBody.safeParse(json);
  if (!parsed.success || parsed.data.object !== 'whatsapp_business_account') return [];
  const out: IncomingMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const { value } of entry.changes) {
      if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== phoneNumberId) continue;
      for (const m of value.messages ?? []) {
        if (m.type !== 'text' || !m.text?.body) continue;
        out.push({
          id: m.id,
          chatId: m.from,
          senderId: m.from,
          text: m.text.body,
          timestamp: (m.timestamp ?? 0) * 1000,
          fromMe: false,
          quotedId: m.context?.id,
        });
      }
    }
  }
  return out;
}

export function createCloudSender(cfg: CloudConfig) {
  const base = `https://graph.facebook.com/${cfg.graphVersion}/${encodeURIComponent(cfg.phoneNumberId)}`;
  const auth = { authorization: `Bearer ${cfg.accessToken}` };
  const opts = { timeoutMs: cfg.timeoutMs ?? 20000, fetchImpl: cfg.fetchImpl, retryable: (r: Response) => r.status === 429 };

  const check = (res: Response, body: string, what: string) => {
    if (res.ok) return JSON.parse(body) as unknown;
    let msg = body.slice(0, 200);
    try {
      msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* keep raw */
    }
    throw new HttpError(`WhatsApp ${what} failed (HTTP ${res.status}): ${msg}`, categorize(res.status), res.status);
  };

  async function uploadMedia(data: Buffer, mimetype: string, fileName: string): Promise<string> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mimetype);
    form.set('file', new Blob([new Uint8Array(data)], { type: mimetype }), fileName);
    const { res, body } = await fetchWithRetry(`${base}/media`, { method: 'POST', headers: auth, body: form }, opts);
    const id = z.object({ id: z.string() }).safeParse(check(res, body, 'media upload'));
    if (!id.success) throw new HttpError('WhatsApp media upload returned no id', 'validation');
    return id.data.id;
  }

  return async function send(to: string, out: Outgoing, quoteId?: string): Promise<string | undefined> {
    const content = out.document
      ? { type: 'document', document: { id: await uploadMedia(out.document.data, out.document.mimetype, out.document.fileName), filename: out.document.fileName, ...(out.text ? { caption: out.text } : {}) } }
      : { type: 'text', text: { body: out.text.slice(0, 4096), preview_url: false } };
    const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...content, ...(quoteId ? { context: { message_id: quoteId } } : {}) };
    const { res, body } = await fetchWithRetry(
      `${base}/messages`,
      { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      opts,
    );
    const parsed = z.object({ messages: z.array(z.object({ id: z.string() })) }).safeParse(check(res, body, 'send'));
    return parsed.success ? parsed.data.messages[0]?.id : undefined;
  };
}

function readBody(req: HttpRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface WebhookOptions {
  cfg: CloudConfig;
  port: number;
  path?: string;
  allowedSenders: string[];
  maxMessageAgeSec: number;
  log: Logger;
  onMessage(msg: IncomingMessage): void;
}

/** Starts the webhook HTTP server. Acknowledges valid events immediately and processes them asynchronously. */
export function startCloudWebhook(o: WebhookOptions): Promise<Server> {
  const path = o.path ?? '/webhook';
  const unknownSenders = new Set<string>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') return void res.writeHead(200).end('ok');
    if (url.pathname !== path) return void res.writeHead(404).end();

    if (req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === o.cfg.verifyToken;
      o.log.info('cloud.verify', { ok });
      return void (ok ? res.writeHead(200, { 'content-type': 'text/plain' }).end(url.searchParams.get('hub.challenge') ?? '') : res.writeHead(403).end());
    }
    if (req.method !== 'POST') return void res.writeHead(405).end();

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      return void res.writeHead(413).end();
    }
    if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, o.cfg.appSecret)) {
      o.log.warn('cloud.bad_signature');
      return void res.writeHead(401).end();
    }
    res.writeHead(200).end();

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return o.log.warn('cloud.bad_json');
    }
    for (const msg of parseWebhook(json, o.cfg.phoneNumberId)) {
      if (!o.allowedSenders.includes(msg.senderId)) {
        if (!unknownSenders.has(msg.senderId)) {
          unknownSenders.add(msg.senderId);
          o.log.info('cloud.sender_not_allowed', { sender: msg.senderId, hint: 'Add to WA_ALLOWED_SENDERS to enable' });
        }
        continue;
      }
      if (msg.timestamp && Date.now() - msg.timestamp > o.maxMessageAgeSec * 1000) continue;
      o.onMessage(msg);
    }
  });
  return new Promise((resolve) => server.listen(o.port, () => resolve(server)));
}
