import { createHash } from 'node:crypto';
import type { ExtractMeta, Extractor } from '../extraction/extract.js';
import type { Extraction } from '../extraction/schema.js';
import { HttpError } from '../http.js';
import type { Logger } from '../logger.js';
import type { BooksApi, IncomingMessage, Invoice, Outgoing, SendFn } from '../types.js';
import { decide, type Decision } from './decide.js';
import { dryRunSummary, invoiceSummary } from './format.js';
import type { PendingClarification, StateStore } from './state.js';

export interface ProcessorOptions {
  ratePolicy: 'ask' | 'item_default';
  baseCurrency: string;
  clarifyTtlMs: number;
  /** When true, never calls createInvoice; replies with a preview instead. */
  dryRun: boolean;
  maxClarifyRounds?: number;
  logMessageText?: boolean;
}

export interface ProcessorDeps {
  extractor: Extractor;
  books: BooksApi;
  store: StateStore;
  send: SendFn;
  log: Logger;
  options: ProcessorOptions;
  now?: () => number;
}

export type Action = 'created' | 'existing' | 'dry_run' | 'clarify' | 'respond' | 'ignore' | 'duplicate' | 'error';

export interface ProcessResult {
  messageId: string;
  action: Action;
  reason?: string;
  decision?: Decision;
  extraction?: Extraction;
  extractMeta?: ExtractMeta;
  invoice?: Invoice;
  associatedPending: boolean;
  timings: Record<string, number>;
  error?: string;
}

const MAX_TEXT = 2000;

export const idempotencyKey = (chatId: string, messageId: string) =>
  `WA-${createHash('sha256').update(`${chatId}|${messageId}`).digest('hex').slice(0, 16).toUpperCase()}`;

const hashId = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);

export class InvoiceProcessor {
  private readonly now: () => number;

  constructor(private readonly deps: ProcessorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async handle(msg: IncomingMessage): Promise<ProcessResult> {
    const started = performance.now();
    const timings: Record<string, number> = {};
    const log = this.deps.log.child({ msg: hashId(msg.id), chat: hashId(msg.chatId), sender: hashId(msg.senderId) });
    const result = (action: Action, extra: Partial<ProcessResult> = {}): ProcessResult => {
      timings.total = Math.round(performance.now() - started);
      const r = { messageId: msg.id, action, associatedPending: false, timings, ...extra };
      log.info('message.done', { action, reason: r.reason, timings, problems: r.decision?.trace.problems });
      return r;
    };

    const text = msg.text.trim();
    if (msg.fromMe) return result('ignore', { reason: 'own_message' });
    if (!text) return result('ignore', { reason: 'empty' });
    if (text.length > MAX_TEXT) return result('ignore', { reason: 'too_long' });
    if (!this.deps.store.markProcessed(msg.id)) return result('duplicate', { reason: 'already_processed' });
    log.info('message.received', { length: text.length, quoted: Boolean(msg.quotedId), ...(this.deps.options.logMessageText ? { text } : {}) });

    const { store } = this.deps;
    let pending: PendingClarification | undefined;
    if (msg.quotedId) {
      pending = store.findPendingByQuestion(msg.chatId, msg.quotedId);
      if (!pending && store.wasQuestion(msg.quotedId)) {
        await this.reply(msg, 'That request has expired or was already handled. Please send the full request again.');
        return result('respond', { reason: 'expired_clarification' });
      }
    } else {
      pending = store.getPending(msg.chatId, msg.senderId);
    }

    let extraction: Extraction;
    let extractMeta: ExtractMeta | undefined;
    const t0 = performance.now();
    const option = pending?.options.length ? text.match(/^\s*(?:option\s*)?#?(\d{1,2})\s*\.?\s*$/i) : null;
    if (pending && option) {
      const chosen = pending.options[Number(option[1]) - 1];
      if (!chosen) {
        await this.reply(msg, `Please reply with a number between 1 and ${pending.options.length}.`);
        return result('clarify', { reason: 'invalid_option', associatedPending: true });
      }
      extraction = structuredClone(pending.extraction);
      extraction.intent = 'clarification_response';
      const line = extraction.items[chosen.lineIndex];
      if (line) line.description = `id:${chosen.itemId}`;
      log.info('clarify.option_selected', { option: Number(option[1]) });
    } else {
      const outcome = await this.deps.extractor.extract(text, pending && { originalText: pending.originalText, question: pending.question });
      extractMeta = outcome.meta;
      timings.extract = Math.round(performance.now() - t0);
      if (!outcome.ok) {
        log.error('extract.failed', { category: outcome.category, error: outcome.error, meta: outcome.meta });
        if (pending || /\d/.test(text)) {
          await this.reply(msg, 'Sorry, I could not read that request right now. Nothing was created; please resend it in a minute.');
        }
        return result('error', { reason: `extract_${outcome.category}`, error: outcome.error, extractMeta });
      }
      extraction = outcome.extraction;
      log.info('extract.ok', { intent: extraction.intent, items: extraction.items.length, missing: extraction.missing, meta: outcome.meta });
    }

    // A pending request is only continued when the model says the message answers it.
    const associated = Boolean(pending) && extraction.intent === 'clarification_response';
    if (pending && !associated && extraction.intent === 'invoice_request') store.clearPending(pending.chatId, pending.senderId);
    if (!pending && extraction.intent === 'clarification_response') extraction.intent = 'invoice_request';

    let decision: Decision;
    try {
      const t1 = performance.now();
      const [customers, items] = await Promise.all([this.deps.books.listCustomers(), this.deps.books.listItems()]);
      timings.catalogue = Math.round(performance.now() - t1);
      const sourceText = pending && (associated || option) ? `${pending.originalText}
${text}` : text;
      decision = decide(extraction, customers, items, { ...this.deps.options, sourceText });
    } catch (e) {
      log.error('catalogue.failed', { error: e });
      await this.reply(msg, 'Sorry, I could not reach Zoho Books to look up customers and items. Nothing was created; please retry shortly.');
      return result('error', { reason: 'catalogue_failed', error: (e as Error).message, extraction, extractMeta });
    }
    log.info('decision', { kind: decision.kind, trace: decision.trace });
    const base = { decision, extraction, extractMeta, associatedPending: associated };

    if (decision.kind === 'ignore') return result('ignore', { ...base, reason: decision.reason });
    if (decision.kind === 'respond') {
      await this.reply(msg, decision.text);
      return result('respond', { ...base, reason: decision.reason });
    }

    if (decision.kind === 'clarify') {
      const rounds = associated ? pending!.attempts + 1 : 1;
      if (rounds > (this.deps.options.maxClarifyRounds ?? 3)) {
        store.clearPending(msg.chatId, pending!.senderId);
        await this.reply(msg, 'I still can’t resolve this request safely, so I have not created an invoice. Please resend the full request with customer, item, quantity and rate.');
        return result('respond', { ...base, reason: 'clarify_rounds_exceeded' });
      }
      const questionMsgId = await this.reply(msg, decision.question);
      store.setPending({
        chatId: msg.chatId,
        senderId: associated ? pending!.senderId : msg.senderId,
        originalText: associated ? `${pending!.originalText}\n[answer] ${text}` : text,
        extraction,
        question: decision.question,
        options: decision.options,
        questionMsgId,
        sourceMsgId: associated ? pending!.sourceMsgId : msg.id,
        attempts: rounds,
        createdAt: this.now(),
        expiresAt: this.now() + this.deps.options.clarifyTtlMs,
      });
      return result('clarify', { ...base, reason: decision.trace.problems.join(',') });
    }

    if (pending && associated) store.clearPending(pending.chatId, pending.senderId);
    const reference = idempotencyKey(msg.chatId, associated ? pending!.sourceMsgId : msg.id);
    const t2 = performance.now();
    try {
      const existing = await this.deps.books.findInvoiceByReference(reference);
      if (existing) {
        await this.reply(msg, invoiceSummary(existing, 'This request was already invoiced:'));
        return result('existing', { ...base, invoice: existing, reason: 'idempotent_hit' });
      }
      if (this.deps.options.dryRun) {
        await this.reply(msg, dryRunSummary(decision.customer.name, decision.lines));
        return result('dry_run', { ...base, reason: 'dry_run' });
      }
      const invoice = await this.createOnce(reference, decision, log);
      timings.zoho = Math.round(performance.now() - t2);
      log.info('invoice.created', { invoiceId: invoice.id, number: invoice.number, status: invoice.status, reference });
      let pdf: Buffer | null = null;
      try {
        pdf = await this.deps.books.getInvoicePdf(invoice.id);
      } catch (e) {
        log.warn('invoice.pdf_failed', { error: e });
      }
      const summary = invoiceSummary(invoice, invoice.status === 'draft' ? 'Draft invoice created:' : 'Invoice created:');
      await this.reply(msg, summary);
      if (pdf) await this.safeSend(msg.chatId, { text: '', document: { data: pdf, fileName: `${invoice.number}.pdf`, mimetype: 'application/pdf' } });
      return result('created', { ...base, invoice });
    } catch (e) {
      const category = e instanceof HttpError ? e.category : 'unknown';
      log.error('invoice.create_failed', { category, error: e, reference });
      const unsure = category === 'timeout' || category === 'transient';
      await this.reply(
        msg,
        unsure
          ? `Zoho did not confirm the invoice (${category}). Please check Zoho Books for reference ${reference} before resending.`
          : `Zoho Books rejected the invoice (${category}): ${(e as Error).message.slice(0, 160)}. Nothing was created.`,
      );
      return result('error', { ...base, reason: `create_${category}`, error: (e as Error).message });
    }
  }

  /** Creates the invoice; on an uncertain failure, checks the reference before a single retry. */
  private async createOnce(reference: string, d: Extract<Decision, { kind: 'create' }>, log: Logger): Promise<Invoice> {
    const input = {
      customerId: d.customer.id,
      referenceNumber: reference,
      lines: d.lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, rate: l.rate })),
      notes: d.notes,
    };
    try {
      return await this.deps.books.createInvoice(input);
    } catch (e) {
      if (!(e instanceof HttpError) || !['timeout', 'transient'].includes(e.category)) throw e;
      log.warn('invoice.create_uncertain', { category: e.category, reference });
      const existing = await this.deps.books.findInvoiceByReference(reference);
      return existing ?? (await this.deps.books.createInvoice(input));
    }
  }

  private reply(msg: IncomingMessage, text: string) {
    return this.safeSend(msg.chatId, { text }, msg.id);
  }

  /** Delivery failures are logged but never change the processing outcome (e.g. an invoice that was created stays "created"). */
  private async safeSend(chatId: string, out: Outgoing, quoteId?: string): Promise<string | undefined> {
    try {
      return await this.deps.send(chatId, out, quoteId);
    } catch (e) {
      this.deps.log.error('reply.failed', { error: e, document: Boolean(out.document) });
      return undefined;
    }
  }
}
