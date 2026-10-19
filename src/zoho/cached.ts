import type { BooksApi, Customer, Item } from '../types.js';

/** Caches the customer/item master lists (they change rarely); invoice calls pass through. */
export class CachedBooks implements BooksApi {
  private customers?: { at: number; value: Promise<Customer[]> };
  private items?: { at: number; value: Promise<Item[]> };

  constructor(
    private readonly inner: BooksApi,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  private cached<T>(slot: { at: number; value: Promise<T> } | undefined, load: () => Promise<T>) {
    if (slot && Date.now() - slot.at < this.ttlMs) return slot;
    const value = load();
    const entry = { at: Date.now(), value };
    value.catch(() => entry.at = 0);
    return entry;
  }

  listCustomers() {
    this.customers = this.cached(this.customers, () => this.inner.listCustomers());
    return this.customers.value;
  }

  listItems() {
    this.items = this.cached(this.items, () => this.inner.listItems());
    return this.items.value;
  }

  findInvoiceByReference(ref: string) {
    return this.inner.findInvoiceByReference(ref);
  }

  createInvoice(...args: Parameters<BooksApi['createInvoice']>) {
    return this.inner.createInvoice(...args);
  }

  getInvoicePdf(id: string) {
    return this.inner.getInvoicePdf(id);
  }

  getInvoice(id: string) {
    return this.inner.getInvoice(id);
  }

  findLastRate(customerId: string, itemId: string) {
    return this.inner.findLastRate(customerId, itemId);
  }

  updateInvoiceLines(...args: Parameters<BooksApi['updateInvoiceLines']>) {
    return this.inner.updateInvoiceLines(...args);
  }

  findTaxId(percent: number) {
    return this.inner.findTaxId(percent);
  }

  async createCustomer(name: string) {
    const c = await this.inner.createCustomer(name);
    this.customers = undefined; // the next lookup must see the new customer
    return c;
  }
}
