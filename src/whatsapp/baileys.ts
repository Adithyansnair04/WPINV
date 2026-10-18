import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import type { Logger } from '../logger.js';
import type { IncomingMessage, Outgoing } from '../types.js';

export interface WhatsAppOptions {
  authDir: string;
  allowedGroups: string[];
  maxMessageAgeSec: number;
  log: Logger;
  onMessage(msg: IncomingMessage): Promise<void>;
}

const RECENT_LIMIT = 500;

export function textOf(m: WAMessage): { text: string; quotedId?: string } {
  const c = m.message;
  if (!c) return { text: '' };
  const ext = c.extendedTextMessage;
  return {
    text: c.conversation ?? ext?.text ?? c.imageMessage?.caption ?? c.documentMessage?.caption ?? '',
    quotedId: ext?.contextInfo?.stanzaId ?? undefined,
  };
}

/** Connects with Baileys (unofficial WhatsApp Web protocol), filters group messages and exposes send(). */
export async function startWhatsApp(opts: WhatsAppOptions) {
  const { log } = opts;
  const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);
  const recent = new Map<string, WAMessage>();
  const seenGroups = new Set<string>();
  let sock: WASocket;

  const connect = async () => {
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    sock = makeWASocket({ auth: state, logger: pino({ level: 'warn' }), ...(version ? { version } : {}), markOnlineOnConnect: false, syncFullHistory: false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        log.info('wa.qr', { hint: 'Scan with WhatsApp > Linked devices' });
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') log.info('wa.connected');
      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          log.error('wa.logged_out', { hint: `Delete ${opts.authDir} and scan the QR again` });
          return;
        }
        log.warn('wa.reconnecting', { code });
        setTimeout(() => void connect(), 3000);
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const chatId = m.key.remoteJid ?? '';
        if (!m.message || m.key.fromMe || !isJidGroup(chatId) || !m.key.id) continue;
        if (!opts.allowedGroups.includes(chatId)) {
          if (!seenGroups.has(chatId)) {
            seenGroups.add(chatId);
            log.info('wa.group_not_allowed', { chatId, hint: 'Add to WA_ALLOWED_GROUPS to enable' });
          }
          continue;
        }
        const ts = Number(m.messageTimestamp ?? 0);
        if (ts && Date.now() / 1000 - ts > opts.maxMessageAgeSec) continue;
        const { text, quotedId } = textOf(m);
        if (!text.trim()) continue;
        recent.set(m.key.id, m);
        if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value!);
        await opts.onMessage({
          id: m.key.id,
          chatId,
          senderId: m.key.participant ?? chatId,
          text,
          timestamp: ts * 1000,
          fromMe: false,
          quotedId,
        });
      }
    });
  };

  await connect();

  return {
    async send(chatId: string, out: Outgoing, quoteId?: string): Promise<string | undefined> {
      const quoted = quoteId ? recent.get(quoteId) : undefined;
      const content = out.document
        ? { document: out.document.data, mimetype: out.document.mimetype, fileName: out.document.fileName, caption: out.text || undefined }
        : { text: out.text };
      const sent = await sock.sendMessage(chatId, content, quoted ? { quoted } : undefined);
      return sent?.key.id ?? undefined;
    },
  };
}
