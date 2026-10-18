import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BooksApi, Customer, Invoice, InvoiceInput, Item } from '../types.js';

const dataPath = (p: string) => fileURLToPath(new URL(`../../data/${p}`, import.meta.url));
const readJson = <T>(p: string): T => JSON.parse(readFileSync(dataPath(p), 'utf8')) as T;

interface SeedCustomer { name: string; company?: string }
interface SeedItem { name: string; sku: string; rate: number; tax_percentage?: number }

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

/** In-memory Zoho Books stand-in built from the seed data. Never touches the network. */
export class MockBooks implements BooksApi {
  readonly invoices: (Invoice & { reference: string; customerId: string })[] = [];
  createCalls = 0;

  constructor(
    readonly customers: Customer[] = seedCustomers(),
    readonly items: Item[] = seedItems(),
  ) {}

  async listCustomers() {
    return this.customers;
  }

  async listItems() {
    return this.items;
  }

  async findInvoiceByReference(reference: string) {
    return this.invoices.find((i) => i.reference === reference) ?? null;
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    this.createCalls++;
    const customer = this.customers.find((c) => c.id === input.customerId);
    if (!customer) throw new Error(`mock: unknown customer ${input.customerId}`);
    const lines = input.lines.map((l) => {
      const item = this.items.find((i) => i.id === l.itemId);
      if (!item) throw new Error(`mock: unknown item ${l.itemId}`);
      return { name: item.name, quantity: l.quantity, rate: l.rate, amount: round2(l.quantity * l.rate), tax: item.taxPercentage ?? 0 };
    });
    const subTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const taxTotal = round2(lines.reduce((s, l) => s + (l.amount * l.tax) / 100, 0));
    const inv = {
      id: `mock-inv-${this.invoices.length + 1}`,
      number: `MOCK-INV-${String(this.invoices.length + 1).padStart(5, '0')}`,
      status: 'draft',
      customerName: customer.name,
      customerId: customer.id,
      currency: 'INR',
      subTotal,
      taxTotal,
      total: round2(subTotal + taxTotal),
      lines: lines.map(({ tax: _t, ...l }) => l),
      reference: input.referenceNumber,
    };
    this.invoices.push(inv);
    return inv;
  }

  async getInvoicePdf() {
    return null;
  }
}
