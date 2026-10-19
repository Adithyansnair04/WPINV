import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZohoBooks, type ZohoCredentials } from '../src/zoho/client.js';

const creds: ZohoCredentials = {
  clientId: 'cid',
  clientSecret: 'S3CR3T-VALUE',
  refreshToken: 'refresh',
  orgId: 'org1',
  apiBase: 'https://www.zohoapis.in/books/v3',
  accountsUrl: 'https://accounts.zoho.in',
  timeoutMs: 1000,
};

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

test('zoho: refreshes token, sends org id + auth header, paginates', async () => {
  let tokens = 0;
  const { impl, calls } = fakeFetch((url) => {
    if (url.pathname === '/oauth/v2/token') return json({ access_token: `tok${++tokens}`, expires_in: 3600, api_domain: 'https://www.zohoapis.in' });
    const page = Number(url.searchParams.get('page'));
    return json({ code: 0, items: [{ item_id: `i${page}`, name: `Item ${page}`, rate: 10, status: 'active' }], page_context: { has_more_page: page < 2 } });
  });
  const z = new ZohoBooks(creds, { fetchImpl: impl, sleep: noSleep });
  const items = await z.listItems();
  assert.equal(items.length, 2);
  assert.equal(tokens, 1);
  const api = calls.filter((c) => c.url.pathname.includes('/books/'));
  assert.equal(api[0]!.url.searchParams.get('organization_id'), 'org1');
  assert.equal((api[0]!.init.headers as Record<string, string>).authorization, 'Zoho-oauthtoken tok1');
});

test('zoho: re-refreshes once on 401, retries 429 with backoff', async () => {
  let tokens = 0;
  let hits = 0;
  const { impl } = fakeFetch((url) => {
    if (url.pathname === '/oauth/v2/token') return json({ access_token: `tok${++tokens}`, expires_in: 3600 });
    hits++;
    if (hits === 1) return json({ code: 57, message: 'not authorized' }, 401);
    if (hits === 2) return json({ code: 44, message: 'rate' }, 429, { 'retry-after': '0' });
    return json({ code: 0, contacts: [{ contact_id: 1, contact_name: 'VK Enterprises', contact_type: 'customer', status: 'active' }] });
  });
  const z = new ZohoBooks(creds, { fetchImpl: impl, sleep: noSleep, aliases: { 'VK Enterprises': ['vk'] } });
  const cs = await z.listCustomers();
  assert.equal(tokens, 2);
  assert.equal(z.stats.rateLimited, 1);
  assert.deepEqual(cs[0]!.aliases, ['vk']);
  assert.equal(cs[0]!.id, '1');
});

test('zoho: does not retry POST on 5xx and surfaces API errors', async () => {
  let posts = 0;
  const { impl } = fakeFetch((url, init) => {
    if (url.pathname === '/oauth/v2/token') return json({ access_token: 't', expires_in: 3600 });
    if (init.method === 'POST') {
      posts++;
      return json({ code: 1, message: 'server' }, 503);
    }
    return json({ code: 0 });
  });
  const z = new ZohoBooks(creds, { fetchImpl: impl, sleep: noSleep });
  await assert.rejects(z.createInvoice({ customerId: 'c', referenceNumber: 'r', lines: [{ itemId: 'i', quantity: 1, rate: 1 }] }), /transient|server/);
  assert.equal(posts, 1);
});

test('zoho: token refresh failure is an auth error without leaking secrets', async () => {
  const { impl } = fakeFetch(() => json({ error: 'invalid_code' }));
  const z = new ZohoBooks(creds, { fetchImpl: impl, sleep: noSleep });
  await assert.rejects(z.listItems(), (e: Error & { category?: string }) => e.category === 'auth' && !e.message.includes('S3CR3T') && !e.message.includes('refresh_token='));
});

test('zoho: create invoice payload and PDF retrieval', async () => {
  let body: Record<string, unknown> = {};
  let sendParam: string | null = null;
  const { impl } = fakeFetch(async (url, init) => {
    if (url.pathname === '/oauth/v2/token') return json({ access_token: 't', expires_in: 3600 });
    if (init.method === 'POST') {
      body = JSON.parse(String(init.body));
      sendParam = url.searchParams.get('send');
      return json({
        code: 0,
        invoice: { invoice_id: '9', invoice_number: 'INV-0009', status: 'draft', customer_name: 'VK', total: 118, sub_total: 100, tax_total: 18, line_items: [] },
      });
    }
    if (url.searchParams.get('accept') === 'pdf') return new Response(Buffer.from('%PDF-1.4'), { headers: { 'content-type': 'application/pdf' } });
    return json({ code: 0 });
  });
  const z = new ZohoBooks(creds, { fetchImpl: impl, sleep: noSleep });
  const inv = await z.createInvoice({ customerId: 'c1', referenceNumber: 'WA-1', lines: [{ itemId: 'i1', quantity: 4, rate: 5200 }] });
  assert.equal(inv.number, 'INV-0009');
  assert.equal(sendParam, 'false');
  assert.deepEqual(body, { customer_id: 'c1', reference_number: 'WA-1', line_items: [{ item_id: 'i1', quantity: 4, rate: 5200 }] });
  assert.equal((await z.getInvoicePdf('9'))?.toString(), '%PDF-1.4');
});

test('zoho: last rate scans newest non-void invoices for the item; update uses PUT with full line items', async () => {
  const calls: { method: string; path: string; query: URLSearchParams; body?: unknown }[] = [];
  const inv = (id: string, number: string, date: string, itemId: string, rate: number) => ({
    code: 0,
    invoice: { invoice_id: id, invoice_number: number, status: 'sent', customer_name: 'VK', customer_id: 'c1', date, total: rate, line_items: [{ item_id: itemId, name: 'x', quantity: 1, rate, item_total: rate }] },
  });
  const { impl } = fakeFetch((url, init) => {
    if (url.pathname === '/oauth/v2/token') return json({ access_token: 't', expires_in: 3600 });
    const path = url.pathname.replace('/books/v3', '');
    calls.push({ method: String(init.method), path, query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/invoices') return json({ code: 0, invoices: [{ invoice_id: '3', status: 'void' }, { invoice_id: '2', status: 'sent' }, { invoice_id: '1', status: 'paid' }] });
    if (path === '/invoices/2') return json(inv('2', 'INV-2', '2026-10-01', 'other', 10));
    if (path === '/invoices/1') return json(inv('1', 'INV-1', '2026-09-01', 'i1', 5100));
    if (path === '/invoices/9' && init.method === 'PUT') return json(inv('9', 'INV-9', '2026-10-19', 'i1', 5200));
    return json({ code: 0 });
  });
  const z = new ZohoBooks(creds, { fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(await z.findLastRate('c1', 'i1'), { rate: 5100, invoiceNumber: 'INV-1', date: '2026-09-01' });
  assert.equal(calls[0]!.query.get('customer_id'), 'c1');
  assert.equal(calls[0]!.query.get('sort_order'), 'D');
  assert.ok(!calls.some((c) => c.path === '/invoices/3'), 'void invoice must not be read');

  const updated = await z.updateInvoiceLines('9', 'c1', [{ itemId: 'i1', quantity: 6, rate: 5200 }]);
  assert.equal(updated.number, 'INV-9');
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.deepEqual(put.body, { customer_id: 'c1', line_items: [{ item_id: 'i1', quantity: 6, rate: 5200 }] });
});

test('zoho: createCustomer posts a customer contact and returns its id', async () => {
  let body: unknown;
  const { impl } = fakeFetch((url, init) => {
    if (url.pathname === '/oauth/v2/token') return json({ access_token: 't', expires_in: 3600 });
    body = JSON.parse(String(init.body));
    return json({ code: 0, contact: { contact_id: 77, contact_name: 'Zenith Motors', contact_type: 'customer', status: 'active' } });
  });
  const c = await new ZohoBooks(creds, { fetchImpl: impl, sleep: noSleep }).createCustomer('Zenith Motors');
  assert.deepEqual(body, { contact_name: 'Zenith Motors', company_name: 'Zenith Motors', contact_type: 'customer' });
  assert.equal(c.id, '77');
  assert.equal(c.name, 'Zenith Motors');
});
