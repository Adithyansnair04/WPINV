import { createHash } from 'node:crypto';
import type { ExtractMeta, Extractor } from '../extraction/extract.js';
import type { Extraction } from '../extraction/schema.js';
import { HttpError } from '../http.js';
import type { Logger } from '../logger.js';
import { ItemMatcher } from '../matching/matcher.js';
import type { BooksApi, IncomingMessage, Invoice, Outgoing, PreviousRate, SendFn } from '../types.js';
import { decide, fmtMoney, type Decision } from './decide.js';
import { dryRunSummary, invoiceSummary } from './format.js';
import { numbersIn } from './grounding.js';
import type { InvoiceRecord, PendingClarification, StateStore } from './state.js';

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

export type Action = 'created' | 'existing' | 'edited' | 'dry_run' | 'clarify' | 'respond' | 'ignore' | 'duplicate' | 'error';

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
const MAX_QTY = 10000;
const MAX_RATE = 10_000_000;
const YES = /^\s*(yes|y|ok|okay|confirm|sure|haan|ha|ji)\b/i;

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
    const optionNo = option ? Number(option[1]) : pending?.options.length === 1 && YES.test(text) ? 1 : null;
    if (pending && optionNo !== null) {
      const chosen = pending.options[optionNo - 1];
      if (!chosen) {
        await this.reply(msg, `Please reply with a number between 1 and ${pending.options.length}.`);
        return result('clarify', { reason: 'invalid_option', associatedPending: true });
      }
      extraction = structuredClone(pending.extraction);
      extraction.intent = 'clarification_response';
      const line = extraction.items[chosen.lineIndex];
      if (line) {
        line.description = `id:${chosen.itemId}`;
        if (chosen.rate !== undefined) {
          line.rate = chosen.rate;
          line.rate_from_previous = true;
        }
      }
      log.info('clarify.option_selected', { option: optionNo, previousRate: chosen.rate !== undefined });
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
    const sourceText = pending && (associated || optionNo !== null) ? `${pending.originalText}\n${text}` : text;

    // The model may only flag "rate from previous invoice"; a number it attaches must be in the message (explicit rate) or is dropped.
    if (extractMeta) {
      const nums = numbersIn(sourceText);
      for (const it of extraction.items) {
        if (!it.rate_from_previous || it.rate === null) continue;
        if (nums.includes(it.rate)) it.rate_from_previous = false;
        else it.rate = null;
      }
    }

    if (extraction.intent === 'edit_request' && msg.quotedId) {
      const target = store.getInvoiceByMessage(msg.quotedId);
      if (target) {
        const r = await this.handleEdit(msg, text, extraction, target, msg.quotedId, log);
        return result(r.action, { ...r, extraction, extractMeta });
      }
    }

    let decision: Decision;
    try {
      const t1 = performance.now();
      const [customers, items] = await Promise.all([this.deps.books.listCustomers(), this.deps.books.listItems()]);
      timings.catalogue = Math.round(performance.now() - t1);
      decision = decide(extraction, customers, items, { ...this.deps.options, sourceText });
      const customerId = decision.trace.customer?.id;
      if (decision.kind === 'clarify' && customerId && decision.trace.problems.includes('rate_from_previous')) {
        const previousRates = new Map<number, PreviousRate | null>();
        for (const [idx, li] of extraction.items.entries()) {
          const itemId = decision.trace.lines[idx]?.itemId;
          if (!li.rate_from_previous || li.rate !== null || !itemId) continue;
          try {
            previousRates.set(idx, await this.deps.books.findLastRate(customerId, itemId));
          } catch (e) {
            log.warn('previous_rate.lookup_failed', { error: e });
          }
        }
        if (previousRates.size) decision = decide(extraction, customers, items, { ...this.deps.options, sourceText, previousRates });
      }
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
      const buttons = decision.options.map((o, i) => [{ text: `${i + 1}) ${o.name}`, data: `opt:${i + 1}` }]);
      const questionMsgId = await this.safeSend(msg.chatId, { text: decision.question, ...(buttons.length ? { buttons } : {}) }, msg.id);
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
        const sid = await this.reply(msg, invoiceSummary(existing, 'This request was already invoiced:'));
        if (sid) store.setInvoiceMessage(sid, this.record(existing, decision, msg.chatId));
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
      const sid = await this.reply(msg, summary);
      if (sid) store.setInvoiceMessage(sid, this.record(invoice, decision, msg.chatId));
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

  private record(inv: Invoice, d: Extract<Decision, { kind: 'create' }>, chatId: string): InvoiceRecord {
    return {
      invoiceId: inv.id,
      number: inv.number,
      chatId,
      customerId: d.customer.id,
      lines: d.lines.map((l) => ({ itemId: l.item.id, name: l.item.name, quantity: l.quantity, rate: l.rate })),
      createdAt: this.now(),
    };
  }

  /**
   * "make it 6 pcs" as a reply to the bot's invoice message. Only drafts, only one line per edit, and the new
   * numbers must appear in the message. The updated summary shows old -> new.
   */
  private async handleEdit(msg: IncomingMessage, text: string, ex: Extraction, target: InvoiceRecord, targetMsgId: string, log: ReturnType<Logger['child']>) {
    const respond = async (reason: string, reply: string) => {
      await this.reply(msg, reply);
      return { action: 'respond' as Action, reason };
    };
    const changes = ex.items.filter((i) => i.quantity !== null || i.rate !== null);
    if (!changes.length) return respond('edit_unclear', 'What should I change? For example "make it 6 pcs" or "rate 5000".');
    if (changes.length > 1) return respond('edit_unclear', 'Please change one item per message.');
    const ch = changes[0]!;

    let idx = target.lines.length === 1 ? 0 : -1;
    if (idx < 0 && ch.description) {
      const r = new ItemMatcher(target.lines.map((l) => ({ id: l.itemId, name: l.name, rate: l.rate, active: true }))).match(ch.description);
      if (r.status === 'matched') idx = target.lines.findIndex((l) => l.itemId === r.record.id);
    }
    if (idx < 0) return respond('edit_unclear', `Which line should change? ${target.lines.map((l) => l.name).join(' / ')}`);

    const nums = numbersIn(text);
    if (ch.quantity !== null && (!nums.includes(ch.quantity) || !Number.isInteger(ch.quantity) || ch.quantity <= 0 || ch.quantity > MAX_QTY)) {
      return respond('edit_invalid', 'Please send the new quantity as a whole number above 0, e.g. "make it 6 pcs".');
    }
    if (ch.rate !== null && (!nums.includes(ch.rate) || ch.rate <= 0 || ch.rate > MAX_RATE)) {
      return respond('edit_invalid', 'Please send the new rate as a number, e.g. "rate 5000".');
    }
    const old = target.lines[idx]!;
    const next = { ...old, quantity: ch.quantity ?? old.quantity, rate: ch.rate ?? old.rate };
    if (next.quantity === old.quantity && next.rate === old.rate) return respond('edit_noop', `${target.number} already has ${old.quantity} × ${fmtMoney(old.rate)} for ${old.name}.`);
    const lines = target.lines.map((l, i) => (i === idx ? next : l));
    const change = `${old.name}: ${old.quantity} × ${fmtMoney(old.rate)} → ${next.quantity} × ${fmtMoney(next.rate)}`;

    try {
      const current = await this.deps.books.getInvoice(target.invoiceId);
      if (current.status !== 'draft') {
        return respond('edit_not_draft', `${target.number} is ${current.status}, so I won't change it here. Please edit it in Zoho Books.`);
      }
      if (this.deps.options.dryRun) return respond('edit_dry_run', `DRY RUN: would update ${target.number}: ${change}`);
      const updated = await this.deps.books.updateInvoiceLines(target.invoiceId, target.customerId, lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, rate: l.rate })));
      log.info('invoice.edited', { invoiceId: updated.id, number: updated.number, line: idx });
      const rec = { ...target, lines, createdAt: this.now() };
      this.deps.store.setInvoiceMessage(targetMsgId, rec);
      const sid = await this.reply(msg, `Changed ${change}\n\n${invoiceSummary(updated, 'Updated draft invoice:')}`);
      if (sid) this.deps.store.setInvoiceMessage(sid, rec);
      return { action: 'edited' as Action, reason: 'edited', invoice: updated };
    } catch (e) {
      const category = e instanceof HttpError ? e.category : 'unknown';
      log.error('invoice.edit_failed', { category, error: e });
      return respond(`edit_${category}`, `I couldn't update ${target.number} (${category}). Nothing was changed; please check Zoho Books.`);
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
