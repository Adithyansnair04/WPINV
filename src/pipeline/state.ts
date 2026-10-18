import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Extraction } from '../extraction/schema.js';
import type { ClarifyOption } from './decide.js';

export interface PendingClarification {
  chatId: string;
  senderId: string;
  originalText: string;
  extraction: Extraction;
  question: string;
  options: ClarifyOption[];
  questionMsgId?: string;
  sourceMsgId: string;
  attempts: number;
  createdAt: number;
  expiresAt: number;
}

/** An invoice the bot created, keyed by the id of the bot message that announced it (so replies to it can edit it). */
export interface InvoiceRecord {
  invoiceId: string;
  number: string;
  chatId: string;
  customerId: string;
  lines: { itemId: string; name: string; quantity: number; rate: number }[];
  createdAt: number;
}

interface StateShape {
  processed: Record<string, number>;
  pending: Record<string, PendingClarification>;
  /** ids of clarification questions we sent, for detecting replies to expired questions */
  questions: Record<string, number>;
  invoices: Record<string, InvoiceRecord>;
}

const PROCESSED_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_PROCESSED = 5000;

export const pendingKey = (chatId: string, senderId: string) => `${chatId}|${senderId}`;

/** Dedupe + pending-clarification state. In-memory when no file path is given. */
export class StateStore {
  private state: StateShape = { processed: {}, pending: {}, questions: {}, invoices: {} };

  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (file) {
      try {
        this.state = { ...this.state, ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch {
        /* first run or unreadable state: start empty */
      }
    }
  }

  /** Atomically checks and marks a message id. Returns false if it was already processed. */
  markProcessed(messageId: string): boolean {
    if (this.state.processed[messageId]) return false;
    this.state.processed[messageId] = this.now();
    this.prune();
    this.save();
    return true;
  }

  getPending(chatId: string, senderId: string): PendingClarification | undefined {
    const p = this.state.pending[pendingKey(chatId, senderId)];
    if (p && p.expiresAt <= this.now()) {
      this.clearPending(chatId, senderId);
      return undefined;
    }
    return p;
  }

  findPendingByQuestion(chatId: string, questionMsgId: string): PendingClarification | undefined {
    return Object.values(this.state.pending).find(
      (p) => p.chatId === chatId && p.questionMsgId === questionMsgId && p.expiresAt > this.now(),
    );
  }

  setPending(p: PendingClarification) {
    this.state.pending[pendingKey(p.chatId, p.senderId)] = p;
    if (p.questionMsgId) this.state.questions[p.questionMsgId] = this.now();
    this.save();
  }

  clearPending(chatId: string, senderId: string) {
    delete this.state.pending[pendingKey(chatId, senderId)];
    this.save();
  }

  /** Open (non-expired) clarifications, for the dashboard. */
  listPending(): PendingClarification[] {
    return Object.values(this.state.pending).filter((p) => p.expiresAt > this.now());
  }

  setInvoiceMessage(messageId: string, rec: InvoiceRecord) {
    this.state.invoices[messageId] = rec;
    this.save();
  }

  getInvoiceByMessage(messageId: string): InvoiceRecord | undefined {
    return this.state.invoices[messageId];
  }

  wasQuestion(messageId: string): boolean {
    return Boolean(this.state.questions[messageId]);
  }

  private prune() {
    const cutoff = this.now() - PROCESSED_TTL_MS;
    for (const [id, rec] of Object.entries(this.state.invoices)) if (rec.createdAt < cutoff) delete this.state.invoices[id];
    for (const bucket of [this.state.processed, this.state.questions]) {
      const entries = Object.entries(bucket);
      for (const [id, ts] of entries) if (ts < cutoff) delete bucket[id];
      if (entries.length > MAX_PROCESSED) {
        entries.sort((a, b) => a[1] - b[1]).slice(0, entries.length - MAX_PROCESSED).forEach(([id]) => delete bucket[id]);
      }
    }
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}
