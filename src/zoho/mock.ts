import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BooksApi, Customer, Invoice, InvoiceInput, InvoiceLineInput, Item, PreviousRate } from '../types.js';

const dataPath = (p: string) => fileURLToPath(new URL(`../../data/${p}`, import.meta.url));
const readJson = <T>(p: string): T => JSON.parse(readFileSync(dataPath(p), 'utf8')) as T;

interface SeedCustomer { name: string; company?: string }
interface SeedItem { name: string; sku: string; rate: number; tax_percentage?: number }
interface SeedInvoice { number: string; date: string; customer: string; status: string; lines: { sku: string; quantity: number; rate: number }[] }

export function loadAliases(): Record<string, string[]> {
  const raw = readJson<Record<string, unknown>>('aliases.json');
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))) as Record<string, string[]>;
}

export function seedCustomers(): Customer[] {
  const aliases = loadAliases();
  return readJson<SeedCustomer[]>('seed/customers.json').map((c, i) => ({
    id: `mock-c${String(i + 1).padStart(3, '0')}`,
    name: c.name,
    companyName: c.company,
    aliases: aliases[c.name] ?? [],
    currency: 'INR',
    active: true,
  }));
}

export function seedItems(): Item[] {
  return readJson<SeedItem[]>('seed/items.json').map((it, i) => ({
    id: `mock-i${String(i + 1).padStart(3, '0')}`,
    name: it.name,
    sku: it.sku,
    rate: it.rate,
    taxPercentage: it.tax_percentage,
    active: true,
  }));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

type MockInvoice = Invoice & { reference: string; customerId: string; date: string };

/** In-memory Zoho Books stand-in built from the seed data (including a small past-invoice history). Never touches the network. */
export class MockBooks implements BooksApi {
  readonly invoices: MockInvoice[] = [];
  createCalls = 0;
  updateCalls = 0;

  constructor(
    readonly customers: Customer[] = seedCustomers(),
    readonly items: Item[] = seedItems(),
    history: SeedInvoice[] = readJson<SeedInvoice[]>('seed/history.json'),
  ) {
    for (const h of history) {
      const customer = customers.find((c) => c.name === h.customer);
      if (!customer) continue;
      const lines = h.lines.flatMap((l) => {
        const item = items.find((i) => i.sku === l.sku);
        return item ? [{ itemId: item.id, quantity: l.quantity, rate: l.rate }] : [];
      });
      this.invoices.push({ ...this.build(`hist-${h.number}`, h.number, customer, lines, ''), status: h.status, date: h.date });
    }
  }

  private build(id: string, number: string, customer: Customer, input: InvoiceLineInput[], reference: string): MockInvoice {
    const lines = input.map((l) => {
      const item = this.items.find((i) => i.id === l.itemId);
      if (!item) throw new Error(`mock: unknown item ${l.itemId}`);
      return { itemId: item.id, name: item.name, quantity: l.quantity, rate: l.rate, amount: round2(l.quantity * l.rate), tax: item.taxPercentage ?? 0 };
    });
    const subTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const taxTotal = round2(lines.reduce((s, l) => s + (l.amount * l.tax) / 100, 0));
    return {
      id,
      number,
      status: 'draft',
      customerName: customer.name,
      customerId: customer.id,
      currency: 'INR',
      subTotal,
      taxTotal,
      total: round2(subTotal + taxTotal),
      date: today(),
      lines: lines.map(({ tax: _t, ...l }) => l),
      reference,
    };
  }

  private customer(id: string) {
    const c = this.customers.find((x) => x.id === id);
    if (!c) throw new Error(`mock: unknown customer ${id}`);
    return c;
  }

  async listCustomers() {
    return this.customers;
  }

  async listItems() {
    return this.items;
  }

  async findInvoiceByReference(reference: string) {
    return this.invoices.find((i) => i.reference && i.reference === reference) ?? null;
  }

  /** Invoices created through the API in this session (history excluded). */
  get created() {
    return this.invoices.filter((i) => i.reference);
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    this.createCalls++;
    const n = this.created.length + 1;
    const inv = this.build(`mock-inv-${n}`, `MOCK-INV-${String(n).padStart(5, '0')}`, this.customer(input.customerId), input.lines, input.referenceNumber);
    this.invoices.push(inv);
    return inv;
  }

  async getInvoice(id: string): Promise<Invoice> {
    const inv = this.invoices.find((i) => i.id === id);
    if (!inv) throw new Error(`mock: unknown invoice ${id}`);
    return inv;
  }

  async findLastRate(customerId: string, itemId: string): Promise<PreviousRate | null> {
    const hits = this.invoices
      .filter((i) => i.customerId === customerId && i.status !== 'void')
      .flatMap((i) => i.lines.filter((l) => l.itemId === itemId).map((l) => ({ rate: l.rate, invoiceNumber: i.number, date: i.date, status: i.status })))
      .sort((a, b) => b.date.localeCompare(a.date));
    return hits[0] ?? null;
  }

  async updateInvoiceLines(invoiceId: string, customerId: string, lines: InvoiceLineInput[]): Promise<Invoice> {
    this.updateCalls++;
    const idx = this.invoices.findIndex((i) => i.id === invoiceId);
    if (idx < 0) throw new Error(`mock: unknown invoice ${invoiceId}`);
    const old = this.invoices[idx]!;
    const updated = { ...this.build(old.id, old.number, this.customer(customerId), lines, old.reference), status: old.status, date: old.date };
    this.invoices[idx] = updated;
    return updated;
  }

  async createCustomer(name: string): Promise<Customer> {
    const c: Customer = { id: `mock-c${String(this.customers.length + 1).padStart(3, '0')}`, name, companyName: name, aliases: [], currency: 'INR', active: true };
    this.customers.push(c);
    return c;
  }

  async getInvoicePdf() {
    return null;
  }
}
