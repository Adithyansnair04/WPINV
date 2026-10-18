import { z } from 'zod';
import { categorize, fetchWithRetry, HttpError, type RetryStats } from '../http.js';
import { silentLogger, type Logger } from '../logger.js';
import type { BooksApi, Customer, Invoice, InvoiceInput, InvoiceLineInput, Item, PreviousRate } from '../types.js';

export interface ZohoCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orgId: string;
  apiBase: string;
  accountsUrl: string;
  timeoutMs: number;
}

interface Opts {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
  aliases?: Record<string, string[]>;
}

const TokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().optional(), api_domain: z.string().optional() });

/** Exchanges the long-lived refresh token for 1-hour access tokens; caches and single-flights refreshes. */
export class ZohoAuth {
  private token?: { value: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(
    private readonly creds: ZohoCredentials,
    private readonly opts: Opts = {},
  ) {}

  async getToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now()) return this.token.value;
    this.inflight ??= this.refresh().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const form = new URLSearchParams({
      refresh_token: this.creds.refreshToken,
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      grant_type: 'refresh_token',
    });
    const { res, body } = await fetchWithRetry(
      `${this.creds.accountsUrl}/oauth/v2/token`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form },
      { timeoutMs: this.creds.timeoutMs, fetchImpl: this.opts.fetchImpl, sleep: this.opts.sleep, maxRetries: 2 },
    );
    let json: unknown = {};
    try {
      json = JSON.parse(body);
    } catch {
      /* handled below */
    }
    const parsed = TokenResponse.safeParse(json);
    if (!res.ok || !parsed.success) {
      const reason = (json as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new HttpError(`Zoho token refresh failed: ${reason}. Check client id/secret, refresh token and ZOHO_ACCOUNTS_URL data centre.`, 'auth', res.status);
    }
    const { access_token, expires_in = 3600, api_domain } = parsed.data;
    if (api_domain && !this.creds.apiBase.startsWith(api_domain)) {
      this.opts.log?.warn('zoho.dc_mismatch', { apiDomain: api_domain, configured: this.creds.apiBase });
    }
    this.token = { value: access_token, expiresAt: Date.now() + (expires_in - 120) * 1000 };
    this.opts.log?.info('zoho.token_refreshed', { expiresIn: expires_in });
    return access_token;
  }
}

const Contact = z.object({
  contact_id: z.coerce.string(),
  contact_name: z.string(),
  company_name: z.string().optional().nullable(),
  contact_type: z.string().optional(),
  status: z.string().optional(),
  currency_code: z.string().optional(),
});
const ZItem = z.object({
  item_id: z.coerce.string(),
  name: z.string(),
  sku: z.string().optional().nullable(),
  rate: z.coerce.number().default(0),
  unit: z.string().optional().nullable(),
  status: z.string().optional(),
  tax_id: z.coerce.string().optional().nullable(),
  tax_percentage: z.coerce.number().optional().nullable(),
});
const PageContext = z.object({ has_more_page: z.boolean().optional() }).optional();
const ZInvoice = z.object({
  invoice_id: z.coerce.string(),
  invoice_number: z.string(),
  status: z.string(),
  customer_name: z.string(),
  customer_id: z.coerce.string().optional(),
  date: z.string().optional(),
  currency_code: z.string().default('INR'),
  sub_total: z.coerce.number().default(0),
  tax_total: z.coerce.number().default(0),
  total: z.coerce.number(),
  invoice_url: z.string().optional().nullable(),
  reference_number: z.string().optional().nullable(),
  line_items: z
    .array(z.object({ item_id: z.coerce.string().optional(), name: z.string(), quantity: z.coerce.number(), rate: z.coerce.number(), item_total: z.coerce.number() }))
    .default([]),
});

const toInvoice = (i: z.infer<typeof ZInvoice>): Invoice => ({
  id: i.invoice_id,
  number: i.invoice_number,
  status: i.status,
  customerName: i.customer_name,
  currency: i.currency_code,
  subTotal: i.sub_total,
  taxTotal: i.tax_total,
  total: i.total,
  url: i.invoice_url ?? undefined,
  customerId: i.customer_id,
  date: i.date,
  lines: i.line_items.map((l) => ({ itemId: l.item_id, name: l.name, quantity: l.quantity, rate: l.rate, amount: l.item_total })),
});

const MAX_PAGES = 25;

export class ZohoBooks implements BooksApi {
  readonly stats: RetryStats = { retries: 0, rateLimited: 0 };
  private readonly auth: ZohoAuth;
  private readonly log: Logger;

  constructor(
    private readonly creds: ZohoCredentials,
    private readonly opts: Opts = {},
  ) {
    this.auth = new ZohoAuth(creds, opts);
    this.log = opts.log ?? silentLogger;
  }

  /** Low-level call. Retries 429/5xx (GET only for 5xx), refreshes the token once on 401. */
  async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    { query = {}, body, accept }: { query?: Record<string, string | number | boolean>; body?: unknown; accept?: 'pdf' } = {},
  ): Promise<{ json: unknown; buffer?: Buffer }> {
    const url = new URL(`${this.creds.apiBase}${path}`);
    url.searchParams.set('organization_id', this.creds.orgId);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    if (accept) url.searchParams.set('accept', accept);

    for (let authAttempt = 0; ; authAttempt++) {
      const token = await this.auth.getToken(authAttempt > 0);
      const started = performance.now();
      const { res, body: text } = await fetchWithRetry(
        url.toString(),
        {
          method,
          headers: { authorization: `Zoho-oauthtoken ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        },
        {
          timeoutMs: this.creds.timeoutMs,
          stats: this.stats,
          fetchImpl: this.opts.fetchImpl,
          sleep: this.opts.sleep,
          retryable: (r, b) => {
            if (r.status === 429) return !b.includes('"code":45'); // 45 = daily limit: do not hammer
            return r.status >= 500 && method === 'GET';
          },
        },
      );
      this.log.debug('zoho.request', { method, path, status: res.status, ms: Math.round(performance.now() - started) });
      if (res.status === 401 && authAttempt === 0) continue;
      if (accept === 'pdf' && res.ok && res.headers.get('content-type')?.includes('application/pdf')) {
        return { json: null, buffer: Buffer.from(await res.arrayBuffer()) };
      }
      let json: { code?: number; message?: string } = {};
      try {
        json = JSON.parse(text);
      } catch {
        if (!res.ok) throw new HttpError(`Zoho HTTP ${res.status}`, categorize(res.status), res.status);
        throw new HttpError('Zoho returned a non-JSON response', 'validation', res.status);
      }
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        throw new HttpError(`Zoho error ${json.code ?? res.status}: ${json.message ?? 'unknown'}`, res.ok ? 'client' : categorize(res.status), res.status);
      }
      return { json };
    }
  }

  private async listAll<T extends z.ZodTypeAny>(path: string, key: string, schema: T, query: Record<string, string> = {}) {
    const out: z.infer<T>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { json } = await this.request('GET', path, { query: { ...query, page, per_page: 200 } });
      const parsed = z.object({ [key]: z.array(schema), page_context: PageContext }).safeParse(json);
      if (!parsed.success) throw new HttpError(`Unexpected Zoho ${path} response shape`, 'validation');
      out.push(...(parsed.data[key] as z.infer<T>[]));
      if (!(parsed.data.page_context as { has_more_page?: boolean } | undefined)?.has_more_page) break;
    }
    return out;
  }

  async listCustomers(): Promise<Customer[]> {
    const contacts = await this.listAll('/contacts', 'contacts', Contact, { contact_type: 'customer' });
    const aliases = this.opts.aliases ?? {};
    return contacts
      .filter((c) => !c.contact_type || c.contact_type === 'customer')
      .map((c) => ({
        id: c.contact_id,
        name: c.contact_name,
        companyName: c.company_name ?? undefined,
        aliases: aliases[c.contact_name] ?? [],
        currency: c.currency_code,
        active: (c.status ?? 'active') === 'active',
      }));
  }

  async listItems(): Promise<Item[]> {
    const items = await this.listAll('/items', 'items', ZItem);
    return items.map((i) => ({
      id: i.item_id,
      name: i.name,
      sku: i.sku ?? undefined,
      rate: i.rate,
      unit: i.unit ?? undefined,
      taxId: i.tax_id ?? undefined,
      taxPercentage: i.tax_percentage ?? undefined,
      active: (i.status ?? 'active') === 'active',
    }));
  }

  async getInvoice(id: string): Promise<Invoice> {
    const { json } = await this.request('GET', `/invoices/${encodeURIComponent(id)}`);
    const parsed = z.object({ invoice: ZInvoice }).safeParse(json);
    if (!parsed.success) throw new HttpError('Unexpected Zoho invoice response shape', 'validation');
    return toInvoice(parsed.data.invoice);
  }

  async findInvoiceByReference(referenceNumber: string): Promise<Invoice | null> {
    const { json } = await this.request('GET', '/invoices', { query: { reference_number: referenceNumber } });
    const parsed = z
      .object({ invoices: z.array(z.object({ invoice_id: z.coerce.string(), reference_number: z.string().optional().nullable() })) })
      .safeParse(json);
    if (!parsed.success) throw new HttpError('Unexpected Zoho invoice list shape', 'validation');
    const hit = parsed.data.invoices.find((i) => i.reference_number === referenceNumber);
    return hit ? this.getInvoice(hit.invoice_id) : null;
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    const { json } = await this.request('POST', '/invoices', {
      query: { send: false },
      body: {
        customer_id: input.customerId,
        reference_number: input.referenceNumber,
        line_items: input.lines.map((l) => ({ item_id: l.itemId, quantity: l.quantity, rate: l.rate })),
        ...(input.notes ? { notes: input.notes.slice(0, 500) } : {}),
      },
    });
    const parsed = z.object({ invoice: ZInvoice }).safeParse(json);
    if (!parsed.success) throw new HttpError('Invoice created but response shape was unexpected; check Zoho before retrying', 'validation');
    return toInvoice(parsed.data.invoice);
  }

  /** Scans the customer's most recent issued invoices (newest first, max 5 detail calls) for the item's last rate; drafts and void invoices are skipped. */
  async findLastRate(customerId: string, itemId: string): Promise<PreviousRate | null> {
    const { json } = await this.request('GET', '/invoices', { query: { customer_id: customerId, sort_column: 'date', sort_order: 'D', per_page: 25 } });
    const list = z.object({ invoices: z.array(z.object({ invoice_id: z.coerce.string(), status: z.string() })) }).safeParse(json);
    if (!list.success) throw new HttpError('Unexpected Zoho invoice list shape', 'validation');
    for (const summary of list.data.invoices.filter((i) => i.status !== 'void' && i.status !== 'draft').slice(0, 5)) {
      const inv = await this.getInvoice(summary.invoice_id);
      const line = inv.lines.find((l) => l.itemId === itemId);
      if (line) return { rate: line.rate, invoiceNumber: inv.number, date: inv.date ?? '' };
    }
    return null;
  }

  /** PUT /invoices/{id}: replaces line items. Callers must only use this for drafts created by this bot. */
  async updateInvoiceLines(invoiceId: string, customerId: string, lines: InvoiceLineInput[]): Promise<Invoice> {
    const { json } = await this.request('PUT', `/invoices/${encodeURIComponent(invoiceId)}`, {
      body: { customer_id: customerId, line_items: lines.map((l) => ({ item_id: l.itemId, quantity: l.quantity, rate: l.rate })) },
    });
    const parsed = z.object({ invoice: ZInvoice }).safeParse(json);
    if (!parsed.success) throw new HttpError('Invoice updated but response shape was unexpected; check Zoho', 'validation');
    return toInvoice(parsed.data.invoice);
  }

  /** GET /invoices/{id}?accept=pdf. Returns null if Zoho does not return a PDF body. */
  async getInvoicePdf(invoiceId: string): Promise<Buffer | null> {
    const r = await this.request('GET', `/invoices/${encodeURIComponent(invoiceId)}`, { accept: 'pdf' });
    return r.buffer ?? null;
  }
}
