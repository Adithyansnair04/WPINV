import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockBooks } from '../src/zoho/mock.js';
import { ex, msg, scripted, setup } from './helpers.js';

const SAME = 'VK lenzo 18 red x 4 rate same as last time';
const sameEx = (rate: number | null = null) => ex({ customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 4, rate, rate_from_previous: true }] });

test('mock history: last rate skips void invoices and is per customer and item', async () => {
  const b = new MockBooks();
  const vk = b.customers.find((c) => c.name === 'VK Enterprises')!;
  const lnz = b.items.find((i) => i.sku === 'LNZ-18-RED')!;
  assert.deepEqual(await b.findLastRate(vk.id, lnz.id), { rate: 5100, invoiceNumber: 'INV-000101', date: '2026-09-28', status: 'paid' });
  const metro = b.customers.find((c) => c.name === 'Metro Car Accessories')!;
  assert.equal(await b.findLastRate(metro.id, lnz.id), null);
});

test('rate same as last time: asks to confirm the looked-up rate with its source, then creates on "yes"', async () => {
  const { processor, books, sent } = setup(scripted({ [SAME]: sameEx() }));
  const r1 = await processor.handle(msg(SAME));
  assert.equal(r1.action, 'clarify');
  assert.ok(r1.decision!.trace.problems.includes('confirm_previous_rate'));
  assert.match(sent[0]!.out.text, /₹5,100 \(invoice INV-000101, 2026-09-28, paid\)/);
  assert.deepEqual(sent[0]!.out.buttons, [[{ text: '1) Yes, ₹5,100 (INV-000101)', data: 'opt:1' }]]);
  assert.equal(books.createCalls, 0);

  const r2 = await processor.handle(msg('yes', { quotedId: sent[0]!.id }));
  assert.equal(r2.action, 'created');
  assert.deepEqual(books.created[0]!.lines.map((l) => [l.name, l.quantity, l.rate]), [['Lenzo Alloy Wheel 18" Red', 4, 5100]]);
});

test('rate same as last time: a rate invented by the model is discarded, never invoiced', async () => {
  const { processor, books } = setup(scripted({ [SAME]: sameEx(4999) }));
  const r = await processor.handle(msg(SAME));
  assert.equal(r.action, 'clarify');
  assert.equal(books.createCalls, 0);
  assert.match(r.decision!.kind === 'clarify' ? r.decision!.question : '', /₹5,100/);
});

test('rate same as last time: no history -> asks for the rate', async () => {
  const text = 'Metro lenzo 18 red x 4 same rate as before';
  const { processor, books } = setup(scripted({ [text]: ex({ customer: 'Metro', items: [{ description: 'lenzo 18 red', quantity: 4, rate: null, rate_from_previous: true }] }) }));
  const r = await processor.handle(msg(text));
  assert.equal(r.action, 'clarify');
  assert.match(r.decision!.kind === 'clarify' ? r.decision!.question : '', /couldn't find an earlier invoice/);
  assert.equal(books.createCalls, 0);
});

const VK = 'VK\nred lenzo alloy 18 inch x 4\nrate 5200';
const VK_EX = ex({ customer: 'VK', items: [{ description: 'red lenzo alloy 18 inch', quantity: 4, rate: 5200 }] });
const editEx = (quantity: number | null, rate: number | null = null) => ex({ intent: 'edit_request', refers_to_previous_invoice: true, items: [{ description: null, quantity, rate }] });

test('edit: replying "make it 6 pcs" to the invoice message updates the draft and shows old -> new', async () => {
  const { processor, books, sent } = setup(scripted({ [VK]: VK_EX, 'make it 6 pcs': editEx(6) }));
  await processor.handle(msg(VK));
  const invoiceMsg = sent[0]!;
  const r = await processor.handle(msg('make it 6 pcs', { quotedId: invoiceMsg.id }));
  assert.equal(r.action, 'edited');
  assert.equal(books.updateCalls, 1);
  assert.equal(books.created[0]!.lines[0]!.quantity, 6);
  assert.equal(books.created[0]!.subTotal, 31200);
  assert.match(sent.at(-1)!.out.text, /Changed Lenzo Alloy Wheel 18" Red: 4 × ₹5,200 → 6 × ₹5,200/);
  assert.equal(books.createCalls, 1);
});

test('edit: without replying to an invoice the bot explains how; nothing changes', async () => {
  const { processor, books } = setup(scripted({ 'make it 6 pcs': editEx(6) }));
  const r = await processor.handle(msg('make it 6 pcs'));
  assert.equal(r.action, 'respond');
  assert.equal(r.reason, 'edit_without_target');
  assert.equal(books.updateCalls, 0);
});

test('edit: refuses non-drafts and numbers not in the message', async () => {
  const { processor, books, sent } = setup(scripted({ [VK]: VK_EX, 'make it 6 pcs': editEx(6), 'change qty': editEx(7) }));
  await processor.handle(msg(VK));
  const invoiceMsg = sent[0]!;
  const ungrounded = await processor.handle(msg('change qty', { quotedId: invoiceMsg.id }));
  assert.equal(ungrounded.reason, 'edit_invalid');
  books.created[0]!.status = 'sent';
  const r = await processor.handle(msg('make it 6 pcs', { quotedId: invoiceMsg.id }));
  assert.equal(r.reason, 'edit_not_draft');
  assert.equal(books.updateCalls, 0);
});

test('rate same as last time uses the newest invoice including drafts, and says it is a draft', async () => {
  const { processor, books, sent } = setup(scripted({ [VK]: VK_EX, [SAME]: sameEx() }));
  await processor.handle(msg(VK)); // a draft at ₹5,200, newer than paid INV-000101 at ₹5,100
  const r = await processor.handle(msg(SAME));
  assert.equal(r.action, 'clarify');
  assert.match(sent.at(-1)!.out.text, /₹5,200 \(invoice MOCK-INV-00001, \d{4}-\d{2}-\d{2}, draft\)/);
  await processor.handle(msg('yes', { quotedId: sent.at(-1)!.id }));
  assert.equal(books.created.at(-1)!.lines[0]!.rate, 5200);
});

test('default tax: lines without an item tax get DEFAULT_TAX_PERCENT; a missing Zoho tax blocks creation', async () => {
  const { processor, books } = setup(scripted({ [VK]: VK_EX }), { options: { defaultTaxPercent: 18 } });
  for (const i of books.items) i.taxPercentage = undefined; // like the live Zoho items: no tax of their own
  const r = await processor.handle(msg(VK));
  assert.equal(r.action, 'created');
  assert.equal(books.created[0]!.taxTotal, 3744);
  assert.equal(books.created[0]!.total, 24544);

  const noTax = setup(scripted({ [VK]: VK_EX }), { options: { defaultTaxPercent: 12 } });
  noTax.books.findTaxId = async () => null;
  const r2 = await noTax.processor.handle(msg(VK));
  assert.equal(r2.action, 'error');
  assert.equal(noTax.books.createCalls, 0);
  assert.match(noTax.sent.at(-1)!.out.text, /No 12% tax exists in Zoho Books/);
});
