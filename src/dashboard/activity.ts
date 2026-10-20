import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProcessResult } from '../pipeline/processor.js';
import type { IncomingMessage } from '../types.js';

export interface ActivityEntry {
  at: number;
  /** Client name, set when more than one client is configured. */
  client?: string;
  chat: string;
  sender: string;
  action: ProcessResult['action'];
  reason?: string;
  text?: string;
  /** LLM that read this message (undefined: no LLM needed, e.g. a button tap or confirmation). */
  model?: string;
  /** Set when the main model failed and `model` is the backup. */
  fallbackFrom?: string;
  primaryError?: string;
  latencyMs: number;
  customer?: { query: string; status: string; name?: string };
  lines: { description: string | null; status: string; item?: string; score?: number; quantity: number | null; rate: number | null }[];
  problems: string[];
  invoice?: { number: string; status: string; total: number; customer: string };
  error?: string;
}

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** Converts a processing result into a dashboard row. Ids are hashed; message text only when explicitly enabled. */
export function toActivity(msg: IncomingMessage, r: ProcessResult, includeText: boolean, client?: string): ActivityEntry {
  const trace = r.decision?.trace;
  return {
    at: Date.now(),
    ...(client ? { client } : {}),
    chat: shortHash(msg.chatId),
    sender: shortHash(msg.senderId),
    action: r.action,
    reason: r.reason,
    ...(includeText ? { text: msg.text.slice(0, 500) } : {}),
    model: r.extractMeta?.model,
    fallbackFrom: r.extractMeta?.fallbackFrom,
    primaryError: r.extractMeta?.primaryError?.slice(0, 120),
    latencyMs: r.timings.total ?? 0,
    customer: trace?.customer && { query: trace.customer.query, status: trace.customer.status, name: trace.customer.name },
    lines: (trace?.lines ?? []).map((l) => ({ description: l.description, status: l.match, item: l.itemName, score: l.score, quantity: l.quantity, rate: l.rate })),
    problems: trace?.problems ?? [],
    invoice: r.invoice && { number: r.invoice.number, status: r.invoice.status, total: r.invoice.total, customer: r.invoice.customerName },
    error: r.error?.slice(0, 200),
  };
}

/** Bounded, optionally file-backed list of recent activity (newest first). */
export class ActivityLog {
  private entries: ActivityEntry[] = [];

  constructor(
    private readonly file?: string,
    private readonly max = 300,
  ) {
    if (file) {
      try {
        this.entries = (JSON.parse(readFileSync(file, 'utf8')) as ActivityEntry[]).slice(0, max);
      } catch {
        /* first run */
      }
    }
  }

  add(e: ActivityEntry) {
    if (e.action === 'duplicate') return;
    this.entries.unshift(e);
    this.entries.length = Math.min(this.entries.length, this.max);
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.entries));
    renameSync(`${this.file}.tmp`, this.file);
  }

  list(): ActivityEntry[] {
    return this.entries;
  }
}
