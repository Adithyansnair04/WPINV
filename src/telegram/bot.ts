import { z } from 'zod';
import { HttpError, categorize, sleep as defaultSleep } from '../http.js';
import type { Logger } from '../logger.js';
import type { IncomingMessage, Outgoing } from '../types.js';

/**
 * Telegram Bot API transport (official, supports groups). Uses long polling (getUpdates), so no public URL is needed.
 * Telegram message ids are only unique per chat, so ids are namespaced as "<chatId>:<messageId>".
 */
export interface TelegramOptions {
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const User = z.object({ id: z.number(), is_bot: z.boolean().default(false) });
const Message = z.object({
  message_id: z.number(),
  date: z.number(),
  chat: z.object({ id: z.number(), type: z.string(), title: z.string().optional() }),
  from: User.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  reply_to_message: z.object({ message_id: z.number() }).optional(),
  migrate_to_chat_id: z.number().optional(),
});
const Update = z.object({ update_id: z.number(), message: Message.optional() });
type Update = z.infer<typeof Update>;

export const msgKey = (chatId: string | number, messageId: number) => `${chatId}:${messageId}`;

export function parseUpdate(u: Update, botId: number): IncomingMessage | null {
  const m = u.message;
  if (!m?.from || m.from.is_bot) return null;
  const text = m.text ?? m.caption;
  if (!text) return null;
  return {
    id: msgKey(m.chat.id, m.message_id),
    chatId: String(m.chat.id),
    senderId: String(m.from.id),
    text,
    timestamp: m.date * 1000,
    fromMe: m.from.id === botId,
    quotedId: m.reply_to_message ? msgKey(m.chat.id, m.reply_to_message.message_id) : undefined,
  };
}

export function createTelegramApi(o: TelegramOptions) {
  const doFetch = o.fetchImpl ?? fetch;
  const wait = o.sleep ?? defaultSleep;
  const base = `https://api.telegram.org/bot${o.token}`;

  /** Calls a Bot API method; honours 429 retry_after once. The token is never included in errors. */
  async function call<T>(method: string, body: Record<string, unknown> | FormData = {}, timeoutMs = o.timeoutMs ?? 20000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}/${method}`, {
          method: 'POST',
          ...(body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        throw new HttpError(`Telegram ${method}: ${timeout ? 'timed out' : 'network error'}`, timeout ? 'timeout' : 'transient');
      }
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
      if (json.ok) return json.result as T;
      if (res.status === 429 && attempt === 0) {
        await wait(Math.min(60, json.parameters?.retry_after ?? 3) * 1000);
        continue;
      }
      throw new HttpError(`Telegram ${method} failed (HTTP ${res.status}): ${json.description ?? 'unknown error'}`, categorize(res.status), res.status);
    }
  }

  async function send(chatId: string, out: Outgoing, quoteId?: string): Promise<string | undefined> {
    const replyTo = quoteId?.startsWith(`${chatId}:`) ? Number(quoteId.slice(chatId.length + 1)) : undefined;
    const reply = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
    let sent: { message_id: number };
    if (out.document) {
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('document', new Blob([new Uint8Array(out.document.data)], { type: out.document.mimetype }), out.document.fileName);
      if (out.text) form.set('caption', out.text.slice(0, 1024));
      if (replyTo) form.set('reply_parameters', JSON.stringify(reply.reply_parameters));
      sent = await call('sendDocument', form, 60000);
    } else {
      sent = await call('sendMessage', { chat_id: chatId, text: out.text.slice(0, 4096), ...reply });
    }
    return msgKey(chatId, sent.message_id);
  }

  return { call, send };
}

export interface PollingOptions {
  api: ReturnType<typeof createTelegramApi>;
  allowedChats: string[];
  maxMessageAgeSec: number;
  log: Logger;
  onMessage(msg: IncomingMessage): void;
  pollTimeoutSec?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Starts the getUpdates loop. Returns stop(). Updates are confirmed (offset) only after they were handed to onMessage. */
export async function startTelegramPolling(o: PollingOptions) {
  const wait = o.sleep ?? defaultSleep;
  const me = await o.api.call<{ id: number; username?: string }>('getMe');
  await o.api.call('deleteWebhook', { drop_pending_updates: false });
  o.log.info('telegram.connected', { bot: me.username });
  const unknownChats = new Set<string>();
  const pollTimeout = o.pollTimeoutSec ?? 25;
  let offset = 0;
  let stopped = false;
  let failures = 0;

  const loop = async () => {
    while (!stopped) {
      try {
        const updates = await o.api.call<unknown[]>('getUpdates', { offset, timeout: pollTimeout, allowed_updates: ['message'] }, (pollTimeout + 15) * 1000);
        failures = 0;
        for (const raw of updates) {
          const parsed = Update.safeParse(raw);
          if (!parsed.success) continue;
          offset = Math.max(offset, parsed.data.update_id + 1);
          const m = parsed.data.message;
          if (m?.migrate_to_chat_id) o.log.warn('telegram.chat_migrated', { from: m.chat.id, to: m.migrate_to_chat_id, hint: 'Update TELEGRAM_ALLOWED_CHATS with the new id' });
          const msg = parseUpdate(parsed.data, me.id);
          if (!msg || msg.fromMe) continue;
          if (!o.allowedChats.includes(msg.chatId)) {
            if (!unknownChats.has(msg.chatId)) {
              unknownChats.add(msg.chatId);
              o.log.info('telegram.chat_not_allowed', { chatId: msg.chatId, title: m?.chat.title, type: m?.chat.type, hint: 'Add to TELEGRAM_ALLOWED_CHATS to enable' });
            }
            continue;
          }
          if (Date.now() - msg.timestamp > o.maxMessageAgeSec * 1000) continue;
          o.onMessage(msg);
        }
      } catch (e) {
        failures++;
        const status = (e as HttpError).status;
        o.log.error('telegram.poll_failed', {
          error: e,
          ...(status === 409 ? { hint: 'Another bot instance is polling with this token' } : {}),
          ...(status === 401 ? { hint: 'TELEGRAM_BOT_TOKEN is invalid' } : {}),
        });
        await wait(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
      }
    }
  };
  const running = loop();
  return {
    me,
    async stop() {
      stopped = true;
      await running;
    },
  };
}
