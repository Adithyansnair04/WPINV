import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ex, msg, scripted, setup } from './helpers.js';

const VK = 'VK\nred lenzo alloy 18 inch x 4\nrate 5200';
const VK_EX = ex({ customer: 'VK', items: [{ description: 'red lenzo alloy 18 inch', quantity: 4, rate: 5200 }] });
const CONFIRM = { options: { invoiceConfirm: true } };
const BOB = 'bob@s.whatsapp.net';

test('invoice confirm: preview first (nothing in Zoho), create only on Yes, exactly once', async () => {
  const { processor, books, sent } = setup(scripted({ [VK]: VK_EX }), CONFIRM);
  const r1 = await processor.handle(msg(VK));
  assert.equal(r1.action, 'clarify');
  assert.equal(r1.reason, 'confirm_invoice');
  assert.equal(books.createCalls, 0, 'nothing created before confirmation');
  const preview = sent[0]!;
  assert.match(preview.out.text, /^Create this draft invoice in Zoho Books\?\nCustomer: VK Enterprises\n1\. Lenzo Alloy Wheel 18" Red — 4 × ₹5,200 = ₹20,800/);
  assert.deepEqual(preview.out.buttons, [[{ text: '✅ Create invoice', data: 'opt:1' }], [{ text: '❌ Cancel', data: 'opt:2' }]]);

  const r2 = await processor.handle(msg('1', { quotedId: preview.id }));
  assert.equal(r2.action, 'created');
  assert.equal(books.createCalls, 1);
  assert.match(sent.at(-1)!.out.text, /Draft invoice created: MOCK-INV-00001/);

  const r3 = await processor.handle(msg('1', { quotedId: preview.id }));
  assert.notEqual(r3.action, 'created');
  assert.equal(books.createCalls, 1, 'a second tap never creates a second invoice');
});

test('invoice confirm: cancel, other members, expiry', async () => {
  let now = 1_000_000;
  const { processor, books, sent } = setup(scripted({ [VK]: VK_EX }), { ...CONFIRM, now: () => now });
  await processor.handle(msg(VK));
  assert.equal((await processor.handle(msg('cancel', { quotedId: sent.at(-1)!.id }))).reason, 'invoice_cancelled');

  await processor.handle(msg(VK, { id: 'second-request' }));
  const preview = sent.at(-1)!;
  assert.equal((await processor.handle(msg('1', { quotedId: preview.id, senderId: BOB }))).reason, 'confirmation_forbidden');
  now += 16 * 60_000;
  assert.equal((await processor.handle(msg('1', { quotedId: preview.id }))).reason, 'confirmation_expired');
  assert.equal(books.createCalls, 0);
});

test('invoice confirm: with INVOICE_APPROVERS only an approver can confirm', async () => {
  const { processor, books, sent } = setup(scripted({ [VK]: VK_EX }), { options: { invoiceConfirm: true, invoiceApprovers: [BOB] } });
  await processor.handle(msg(VK));
  const preview = sent.at(-1)!;
  assert.equal((await processor.handle(msg('1', { quotedId: preview.id }))).reason, 'confirmation_forbidden');
  assert.equal((await processor.handle(msg('yes', { quotedId: preview.id, senderId: BOB }))).action, 'created');
  assert.equal(books.createCalls, 1);
});

test('invoice confirm: a record removed before Yes blocks creation; dry run skips the confirmation', async () => {
  const { processor, books, sent } = setup(scripted({ [VK]: VK_EX }), CONFIRM);
  await processor.handle(msg(VK));
  books.customers.find((c) => c.name === 'VK Enterprises')!.active = false;
  assert.equal((await processor.handle(msg('1', { quotedId: sent.at(-1)!.id }))).reason, 'invoice_records_changed');
  assert.equal(books.createCalls, 0);

  const dry = setup(scripted({ [VK]: VK_EX }), { ...CONFIRM, dryRun: true });
  assert.equal((await dry.processor.handle(msg(VK))).action, 'dry_run');
});
