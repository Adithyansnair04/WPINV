import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCustomerName, parseAddCustomer } from '../src/pipeline/processor.js';
import { ex, msg, scripted, setup } from './helpers.js';

const ON = { options: { customerCreate: 'confirm' as const } };
const BOB = 'bob';

test('add customer: command parsing and name validation', () => {
  assert.equal(parseAddCustomer('add customer Zenith Motors'), 'Zenith Motors');
  assert.equal(parseAddCustomer('Add new customer: "Zenith Motors"'), '"Zenith Motors"');
  assert.equal(parseAddCustomer('/addcustomer@wpinv_bot Zenith'), 'Zenith');
  assert.equal(parseAddCustomer('add customer'), '');
  assert.equal(parseAddCustomer('VK lenzo 18 red x 4'), null);
  assert.equal(cleanCustomerName('"Zenith   Motors"'), 'Zenith Motors');
  assert.equal(cleanCustomerName('x'), null);
  assert.equal(cleanCustomerName('https://evil.example'), null);
  assert.equal(cleanCustomerName('1234'), null);
});

test('add customer: asks for confirmation first, creates only on Yes, then it is matchable', async () => {
  const { processor, books, sent } = setup(scripted({}), ON);
  const before = books.customers.length;
  const r1 = await processor.handle(msg('add customer Zenith Motors'));
  assert.equal(r1.action, 'clarify');
  assert.equal(r1.reason, 'confirm_new_customer');
  const q = sent[0]!;
  assert.match(q.out.text, /Add new customer "Zenith Motors" to Zoho Books\?/);
  assert.match(q.out.text, /Similar existing customers: Sri Ganesh Motors/);
  assert.deepEqual(q.out.buttons, [[{ text: '✅ Yes, add customer', data: 'opt:1' }], [{ text: '❌ Cancel', data: 'opt:2' }]]);
  assert.equal(books.customers.length, before, 'nothing created before confirmation');

  const r2 = await processor.handle(msg('1', { quotedId: q.id }));
  assert.equal(r2.reason, 'customer_created');
  assert.equal(books.customers.length, before + 1);
  assert.equal(books.customers.at(-1)!.name, 'Zenith Motors');
  assert.match(sent.at(-1)!.out.text, /✅ Added customer "Zenith Motors"/);

  // Single use: tapping Yes again does nothing.
  const r3 = await processor.handle(msg('1', { quotedId: q.id }));
  assert.notEqual(r3.reason, 'customer_created');
  assert.equal(books.customers.length, before + 1);
});

test('add customer: cancel, duplicates, other members, expiry and the off switch', async () => {
  let now = 1_000_000;
  const { processor, books, sent } = setup(scripted({}), { ...ON, now: () => now });
  const before = books.customers.length;

  await processor.handle(msg('add customer Zenith Motors'));
  assert.equal((await processor.handle(msg('cancel', { quotedId: sent.at(-1)!.id }))).reason, 'customer_create_cancelled');

  assert.equal((await processor.handle(msg('add customer VK Enterprises'))).reason, 'customer_exists');

  await processor.handle(msg('add customer Zenith Motors'));
  const q = sent.at(-1)!;
  assert.equal((await processor.handle(msg('1', { quotedId: q.id, senderId: BOB }))).reason, 'confirmation_forbidden');
  now += 16 * 60_000;
  assert.equal((await processor.handle(msg('1', { quotedId: q.id }))).reason, 'confirmation_expired');
  assert.equal(books.customers.length, before);

  const off = setup(scripted({}), { options: { customerCreate: 'off' } });
  assert.equal((await off.processor.handle(msg('add customer Zenith Motors'))).reason, 'customer_create_off');
});

test('add customer: creator allowlist', async () => {
  const { processor, books, sent } = setup(scripted({}), { options: { customerCreate: 'confirm', customerCreators: [BOB] } });
  assert.equal((await processor.handle(msg('add customer Zenith Motors'))).reason, 'customer_create_forbidden');
  await processor.handle(msg('add customer Zenith Motors', { senderId: BOB }));
  await processor.handle(msg('yes', { quotedId: sent.at(-1)!.id, senderId: BOB }));
  assert.equal(books.customers.at(-1)!.name, 'Zenith Motors');
});

test('add customer from an invoice: unknown customer offers ➕, confirm, then the same invoice continues', async () => {
  const text = 'Zenith Motors lenzo 18 red x 4 rate 5200';
  const { processor, books, sent } = setup(
    scripted({ [text]: ex({ customer: 'Zenith Motors', items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5200 }] }) }),
    ON,
  );
  const r1 = await processor.handle(msg(text));
  assert.equal(r1.action, 'clarify');
  assert.match(sent[0]!.out.text, /Add "Zenith Motors" as a new customer/);
  assert.deepEqual(sent[0]!.out.buttons![0], [{ text: '1) ➕ Add new customer "Zenith Motors"', data: 'opt:1' }]);

  const r2 = await processor.handle(msg('1', { quotedId: sent[0]!.id }));
  assert.equal(r2.reason, 'confirm_new_customer');
  assert.equal(books.createCalls, 0);

  const r3 = await processor.handle(msg('1', { quotedId: sent.at(-1)!.id }));
  assert.equal(r3.action, 'created');
  assert.equal(books.created[0]!.customerName, 'Zenith Motors');
  assert.deepEqual(books.created[0]!.lines.map((l) => [l.name, l.quantity, l.rate]), [['Lenzo Alloy Wheel 18" Red', 4, 5200]]);
});

test('add customer: feature off by default keeps the old question', async () => {
  const text = 'Zenith Motors lenzo 18 red x 4 rate 5200';
  const { processor, sent } = setup(scripted({ [text]: ex({ customer: 'Zenith Motors', items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5200 }] }) }));
  await processor.handle(msg(text));
  assert.doesNotMatch(sent[0]!.out.text, /new customer/);
  assert.equal(sent[0]!.out.buttons, undefined);
});
