import { createHash } from 'node:crypto';
import type { ExtractMeta, Extractor } from '../extraction/extract.js';
import type { Extraction } from '../extraction/schema.js';
import { HttpError } from '../http.js';
import type { Logger } from '../logger.js';
import { CustomerMatcher, ItemMatcher } from '../matching/matcher.js';
import type { BooksApi, IncomingMessage, Invoice, InvoiceLineInput, Outgoing, PreviousRate, SendFn } from '../types.js';
import { decide, fmtMoney, type Decision } from './decide.js';
import { confirmPreview, dryRunSummary, invoiceSummary } from './format.js';
import { numbersIn } from './grounding.js';
import type { InvoiceRecord, PendingClarification, PendingConfirmation, StateStore } from './state.js';

export interface ProcessorOptions {
  ratePolicy: 'ask' | 'item_default';
  baseCurrency: string;
  clarifyTtlMs: number;
  /** When true, never calls createInvoice; replies with a preview instead. */
  dryRun: boolean;
  maxClarifyRounds?: number;
  logMessageText?: boolean;
  /** 'confirm' allows adding customers from chat after an explicit Yes. */
  customerCreate?: 'confirm' | 'off';
  /** If non-empty, only these sender ids may add customers. */
  customerCreators?: string[];
  /** Tax % applied to lines whose item has no tax in Zoho. */
  defaultTaxPercent?: number;
  /** Show a preview and create in Zoho only after an explicit Yes. */
  invoiceConfirm?: boolean;
  /** If non-empty, only these sender ids may confirm invoices (otherwise the requester). */
  invoiceApprovers?: string[];
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
const CONFIRM_YES = /^\s*(1|yes|y|ok|okay|confirm|haan|ha|ji)\b/i;
const CONFIRM_NO = /^\s*(2|no|n|cancel|stop|nahi)\b/i;

/** "add customer Zenith Motors", "new customer: X", "/addcustomer X" -> name ('' if no name given); null if not a command. */
export function parseAddCustomer(text: string): string | null {
  const m = text.match(/^\s*(?:\/addcustomer(?:@\w+)?|add\s+(?:a\s+)?(?:new\s+)?customer|new\s+customer)\b\s*[:\-–]?\s*(.*)$/is);
  return m ? m[1]!.trim() : null;
}

/** Normalizes a customer name typed in chat; null if it is not a plausible name. */
export function cleanCustomerName(raw: string): string | null {
  const name = raw.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60 || !/[a-z]/i.test(name) || /[\n@<>]|https?:/i.test(name)) return null;
  return name;
}

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
    if (text.toLowerCase() === '/whoami' || /^\/whoami@\w+$/i.test(text)) {
      await this.reply(msg, `Your user id: ${msg.senderId}\nThis chat id: ${msg.chatId}`);
      return result('respond', { reason: 'whoami' });
    }
    const command = parseAddCustomer(text);
    if (command !== null) {
      const r = await this.requestCustomerCreate(msg, command, undefined);
      return result(r.action, { reason: r.reason });
    }
    let createdCustomer: string | undefined;
    let confirmation: PendingConfirmation | undefined;
    if (msg.quotedId && store.getConfirmation(msg.quotedId)?.kind === 'invoice') {
      const r = await this.handleInvoiceConfirmation(msg, text, msg.quotedId, log, timings);
      return result(r.action, r);
    }
    if (msg.quotedId && store.getConfirmation(msg.quotedId)) {
      const r = await this.handleConfirmation(msg, text, msg.quotedId, log);
      confirmation = r.confirmation;
      if (!r.created || !confirmation?.resumeSourceMsgId) return result(r.action, { reason: r.reason });
      createdCustomer = r.created;
    }

    let pending: PendingClarification | undefined;
    if (createdCustomer) {
      // Continue the invoice that asked for this customer, if it is still waiting.
      const p = store.getPending(msg.chatId, confirmation!.resumeRequesterId ?? confirmation!.requesterId);
      pending = p?.sourceMsgId === confirmation!.resumeSourceMsgId ? p : undefined;
      if (!pending) return result('respond', { reason: 'customer_created' });
    } else if (msg.quotedId) {
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
    if (pending && createdCustomer) {
      extraction = structuredClone(pending.extraction);
      extraction.intent = 'clarification_response';
      extraction.customer = createdCustomer;
      log.info('customer.resume_request');
    } else if (pending && optionNo !== null) {
      const chosen = pending.options[optionNo - 1];
      if (!chosen) {
        await this.reply(msg, `Please reply with a number between 1 and ${pending.options.length}.`);
        return result('clarify', { reason: 'invalid_option', associatedPending: true });
      }
      if (chosen.newCustomer) {
        const r = await this.requestCustomerCreate(msg, chosen.newCustomer, pending);
        return result(r.action, { reason: r.reason, associatedPending: true });
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
      decision = decide(extraction, customers, items, { ...this.deps.options, allowCustomerCreate: this.deps.options.customerCreate === 'confirm', sourceText });
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
        if (previousRates.size) decision = decide(extraction, customers, items, { ...this.deps.options, allowCustomerCreate: this.deps.options.customerCreate === 'confirm', sourceText, previousRates });
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
    let existing: Invoice | null;
    try {
      existing = await this.deps.books.findInvoiceByReference(reference);
    } catch (e) {
      log.error('invoice.lookup_failed', { error: e });
      await this.reply(msg, 'Sorry, I could not reach Zoho Books. Nothing was created; please retry shortly.');
      return result('error', { ...base, reason: 'zoho_unreachable', error: (e as Error).message });
    }
    if (existing) {
      const sid = await this.reply(msg, invoiceSummary(existing, 'This request was already invoiced:'));
      if (sid) store.setInvoiceMessage(sid, this.record(existing, decision, msg.chatId));
      return result('existing', { ...base, invoice: existing, reason: 'idempotent_hit' });
    }
    if (this.deps.options.dryRun) {
      await this.reply(msg, dryRunSummary(decision.customer.name, decision.lines, this.deps.options.defaultTaxPercent));
      return result('dry_run', { ...base, reason: 'dry_run' });
    }
    if (this.deps.options.invoiceConfirm) {
      // Nothing is written to Zoho until someone confirms this preview.
      const buttons = [[{ text: '✅ Create invoice', data: 'opt:1' }], [{ text: '❌ Cancel', data: 'opt:2' }]];
      const id = await this.safeSend(msg.chatId, { text: confirmPreview(decision.customer.name, decision.lines, this.deps.options.defaultTaxPercent), buttons }, msg.id);
      if (!id) return result('error', { ...base, reason: 'confirmation_not_sent' });
      store.setConfirmation(id, {
        kind: 'invoice',
        chatId: msg.chatId,
        requesterId: associated ? pending!.senderId : msg.senderId,
        name: decision.customer.name,
        invoice: {
          customerId: decision.customer.id,
          lines: decision.lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, rate: l.rate, rateSource: l.rateSource })),
          notes: decision.notes,
          reference,
        },
        createdAt: this.now(),
        expiresAt: this.now() + this.deps.options.clarifyTtlMs,
      });
      return result('clarify', { ...base, reason: 'confirm_invoice' });
    }
    const r = await this.createAndReply(msg, decision, reference, log, timings);
    return result(r.action, { ...base, ...r });
  }

  /** Creates the draft in Zoho, fetches the PDF and replies. Used directly, or after an invoice confirmation. */
  private async createAndReply(
    msg: IncomingMessage,
    decision: Extract<Decision, { kind: 'create' }>,
    reference: string,
    log: ReturnType<Logger['child']>,
    timings: Record<string, number>,
  ): Promise<{ action: Action; reason?: string; invoice?: Invoice; error?: string }> {
    const { store } = this.deps;
    const t2 = performance.now();
    try {
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
      return { action: 'created', invoice };
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
      return { action: 'error', reason: `create_${category}`, error: (e as Error).message };
    }
  }

  /** Yes creates the previewed invoice (once); Cancel discards. Requester, or only INVOICE_APPROVERS when that list is set. */
  private async handleInvoiceConfirmation(
    msg: IncomingMessage,
    text: string,
    confirmationId: string,
    log: ReturnType<Logger['child']>,
    timings: Record<string, number>,
  ): Promise<{ action: Action; reason?: string; invoice?: Invoice; error?: string }> {
    const { store, books } = this.deps;
    const respond = async (reason: string, reply: string) => {
      await this.reply(msg, reply);
      return { action: 'respond' as Action, reason };
    };
    const conf = store.getConfirmation(confirmationId)!;
    if (conf.chatId !== msg.chatId || !conf.invoice) return { action: 'ignore', reason: 'confirmation_other_chat' };
    if (conf.expiresAt <= this.now()) {
      store.takeConfirmation(confirmationId);
      return respond('confirmation_expired', 'This invoice confirmation has expired. Nothing was created; please send the request again.');
    }
    const approvers = this.deps.options.invoiceApprovers ?? [];
    if (approvers.length ? !approvers.includes(msg.senderId) : msg.senderId !== conf.requesterId) {
      return respond('confirmation_forbidden', approvers.length ? 'Only an approver can confirm this invoice.' : 'Only the person who asked can confirm this invoice.');
    }
    const yes = CONFIRM_YES.test(text);
    if (!yes && !CONFIRM_NO.test(text)) {
      await this.reply(msg, 'Please tap ✅ Create invoice or ❌ Cancel (or reply 1 / 2).');
      return { action: 'clarify', reason: 'confirmation_unclear' };
    }
    const taken = store.takeConfirmation(confirmationId);
    if (!taken?.invoice) return { action: 'ignore', reason: 'confirmation_already_used' };
    if (!yes) return respond('invoice_cancelled', 'Cancelled. No invoice was created.');

    const inv = taken.invoice;
    let decision: Extract<Decision, { kind: 'create' }>;
    try {
      const [customers, items] = await Promise.all([books.listCustomers(), books.listItems()]);
      const customer = customers.find((c) => c.id === inv.customerId && c.active);
      const lines = inv.lines.map((l) => ({ ...l, item: items.find((i) => i.id === l.itemId && i.active) }));
      if (!customer || lines.some((l) => !l.item)) {
        return respond('invoice_records_changed', 'The customer or an item no longer exists in Zoho Books. Nothing was created; please send the request again.');
      }
      decision = {
        kind: 'create',
        customer,
        lines: lines.map((l) => ({ description: l.item!.name, item: l.item!, quantity: l.quantity, rate: l.rate, rateSource: l.rateSource })),
        notes: inv.notes,
        trace: { lines: [], problems: [] },
      };
      const existing = await books.findInvoiceByReference(inv.reference);
      if (existing) {
        const sid = await this.reply(msg, invoiceSummary(existing, 'This request was already invoiced:'));
        if (sid) store.setInvoiceMessage(sid, this.record(existing, decision, msg.chatId));
        return { action: 'existing', reason: 'idempotent_hit', invoice: existing };
      }
    } catch (e) {
      log.error('invoice.confirm_lookup_failed', { error: e });
      return respond('zoho_unreachable', 'Sorry, I could not reach Zoho Books. Nothing was created; please send the request again shortly.');
    }
    log.info('invoice.confirmed', { reference: inv.reference });
    return this.createAndReply(msg, decision, inv.reference, log, timings);
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
      const updated = await this.deps.books.updateInvoiceLines(target.invoiceId, target.customerId, await this.withTax(lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, rate: l.rate }))));
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

  private mayCreateCustomers(senderId: string): boolean {
    const creators = this.deps.options.customerCreators ?? [];
    return this.deps.options.customerCreate === 'confirm' && (!creators.length || creators.includes(senderId));
  }

  /** Step 1 of adding a customer: validate, check for duplicates, and ask for an explicit Yes/Cancel. Nothing is created here. */
  private async requestCustomerCreate(msg: IncomingMessage, rawName: string, pending: PendingClarification | undefined): Promise<{ action: Action; reason: string }> {
    const respond = async (reason: string, text: string) => {
      await this.reply(msg, text);
      return { action: 'respond' as Action, reason };
    };
    if (this.deps.options.customerCreate !== 'confirm') return respond('customer_create_off', 'Adding customers from chat is turned off. Please add them in Zoho Books.');
    if (!this.mayCreateCustomers(msg.senderId)) return respond('customer_create_forbidden', 'Only authorised users can add customers. Please ask an admin.');
    if (!rawName) return respond('customer_create_usage', 'To add a customer, send: add customer <full name>');
    const name = cleanCustomerName(rawName);
    if (!name) return respond('customer_create_invalid', 'That does not look like a customer name (2–60 characters, no links). Please send: add customer <full name>');

    const r = new CustomerMatcher(await this.deps.books.listCustomers()).match(name);
    if (r.status === 'matched') return respond('customer_exists', `"${r.record.name}" already exists, so there is no need to add it.`);
    const similar = r.candidates.filter((c) => c.score >= 0.5).slice(0, 3).map((c) => c.record.name);
    const text = [
      `Add new customer "${name}" to Zoho Books?`,
      ...(similar.length ? [`⚠️ Similar existing customers: ${similar.join(' / ')}`] : []),
      'Please check the spelling: this creates a permanent customer record.',
      `  1) Yes, add "${name}"`,
      '  2) Cancel',
      '',
      'Tap a button or reply to this message with 1 or 2.',
    ].join('\n');
    const buttons = [[{ text: '✅ Yes, add customer', data: 'opt:1' }], [{ text: '❌ Cancel', data: 'opt:2' }]];
    const id = await this.safeSend(msg.chatId, { text, buttons }, msg.id);
    if (!id) return { action: 'error', reason: 'confirmation_not_sent' };
    this.deps.store.setConfirmation(id, {
      chatId: msg.chatId,
      requesterId: msg.senderId,
      name,
      resumeSourceMsgId: pending?.sourceMsgId,
      resumeRequesterId: pending?.senderId,
      createdAt: this.now(),
      expiresAt: this.now() + this.deps.options.clarifyTtlMs,
    });
    return { action: 'clarify', reason: 'confirm_new_customer' };
  }

  /** Step 2: Yes creates the customer (once), Cancel discards. Only the requester (or an authorised creator) may answer. */
  private async handleConfirmation(
    msg: IncomingMessage,
    text: string,
    confirmationId: string,
    log: ReturnType<Logger['child']>,
  ): Promise<{ action: Action; reason: string; created?: string; confirmation?: PendingConfirmation }> {
    const { store, books } = this.deps;
    const respond = async (reason: string, reply: string, confirmation?: PendingConfirmation) => {
      await this.reply(msg, reply);
      return { action: 'respond' as Action, reason, confirmation };
    };
    const conf = store.getConfirmation(confirmationId)!;
    if (conf.chatId !== msg.chatId) return { action: 'ignore', reason: 'confirmation_other_chat' };
    if (conf.expiresAt <= this.now()) {
      store.takeConfirmation(confirmationId);
      return respond('confirmation_expired', 'That confirmation has expired. Nothing was added. Send "add customer <name>" again.');
    }
    const creators = this.deps.options.customerCreators ?? [];
    if (msg.senderId !== conf.requesterId && !(creators.length && creators.includes(msg.senderId))) {
      return respond('confirmation_forbidden', 'Only the person who asked can confirm adding this customer.');
    }
    const yes = CONFIRM_YES.test(text);
    if (!yes && !CONFIRM_NO.test(text)) {
      await this.reply(msg, 'Please tap ✅ Yes or ❌ Cancel (or reply 1 / 2).');
      return { action: 'clarify', reason: 'confirmation_unclear' };
    }
    const taken = store.takeConfirmation(confirmationId);
    if (!taken) return { action: 'ignore', reason: 'confirmation_already_used' };
    if (!yes) return respond('customer_create_cancelled', `Cancelled. "${taken.name}" was not added.`);
    if (!this.mayCreateCustomers(msg.senderId) && msg.senderId !== taken.requesterId) {
      return respond('customer_create_forbidden', 'Only authorised users can add customers.');
    }

    try {
      const existing = new CustomerMatcher(await books.listCustomers()).match(taken.name);
      if (existing.status === 'matched') {
        await this.reply(msg, `"${existing.record.name}" already exists, so nothing new was added.`);
        return { action: 'respond', reason: 'customer_exists', created: existing.record.name, confirmation: taken };
      }
      if (this.deps.options.dryRun) return respond('customer_create_dry_run', `DRY RUN: would add customer "${taken.name}".`, taken);
      const c = await books.createCustomer(taken.name);
      log.info('customer.created', { customerId: c.id });
      await this.reply(msg, `✅ Added customer "${c.name}".${taken.resumeSourceMsgId ? ' Continuing your invoice…' : ''}`);
      return { action: 'respond', reason: 'customer_created', created: c.name, confirmation: taken };
    } catch (e) {
      const category = e instanceof HttpError ? e.category : 'unknown';
      log.error('customer.create_failed', { category, error: e });
      return respond(`customer_create_${category}`, `I couldn't add "${taken.name}" (${(e as Error).message.slice(0, 140)}). Nothing was added; please add it in Zoho Books.`, taken);
    }
  }

  /** Adds DEFAULT_TAX_PERCENT to lines whose item has no tax in Zoho. Fails (nothing created) if that tax does not exist. */
  private async withTax(lines: InvoiceLineInput[]): Promise<InvoiceLineInput[]> {
    const pct = this.deps.options.defaultTaxPercent;
    if (pct === undefined) return lines;
    const items = await this.deps.books.listItems();
    const untaxed = (l: InvoiceLineInput) => !items.find((i) => i.id === l.itemId)?.taxId;
    if (!lines.some(untaxed)) return lines;
    const taxId = await this.deps.books.findTaxId(pct);
    if (!taxId) throw new HttpError(`No ${pct}% tax exists in Zoho Books. Create it under Settings → Taxes (or run npm run zoho:seed -- --confirm --tax ${pct}).`, 'client');
    return lines.map((l) => (untaxed(l) ? { ...l, taxId } : l));
  }

  /** Creates the invoice; on an uncertain failure, checks the reference before a single retry. */
  private async createOnce(reference: string, d: Extract<Decision, { kind: 'create' }>, log: Logger): Promise<Invoice> {
    const input = {
      customerId: d.customer.id,
      referenceNumber: reference,
      lines: await this.withTax(d.lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, rate: l.rate }))),
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
