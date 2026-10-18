import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExtraction } from '../src/extraction/extract.js';
import { decide } from '../src/pipeline/decide.js';
import { idempotencyKey } from '../src/pipeline/processor.js';
import { seedCustomers, seedItems } from '../src/zoho/mock.js';
import { ex, msg, scripted, setup } from './helpers.js';

const VK_REQUEST = 'VK\nred lenzo alloy 18 inch x 4\nrate 5200';
const VK_EX = ex({ customer: 'VK', items: [{ description: 'red lenzo alloy 18 inch', quantity: 4, rate: 5200 }] });
const opts = { ratePolicy: 'ask' as const, baseCurrency: 'INR' };

test('schema: coerces numeric strings, rejects junk', () => {
  const ok = parseExtraction('```json\n{"intent":"invoice_request","customer":"VK","items":[{"description":"x","quantity":"4","rate":"₹5,200"}]}\n```');
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.value.items[0]!.rate, 5200);
  assert.equal(ok.ok && ok.value.items[0]!.quantity, 4);
  assert.equal(parseExtraction('{"intent":"order","items":[]}').ok, false);
  assert.equal(parseExtraction('{"intent":"invoice_request","items":[{"description":"x","quantity":"four"}]}').ok, false);
  assert.equal(parseExtraction('not json').ok, false);
});

test('decide: creates only with exact records and all fields', () => {
  const parsed = parseExtraction(JSON.stringify(VK_EX));
  assert.ok(parsed.ok);
  const d = decide(parsed.value, seedCustomers(), seedItems(), opts);
  assert.equal(d.kind, 'create');
  if (d.kind === 'create') {
    assert.equal(d.customer.name, 'VK Enterprises');
    assert.equal(d.lines[0]!.item.sku, 'LNZ-18-RED');
    assert.equal(d.lines[0]!.quantity, 4);
    assert.equal(d.lines[0]!.rate, 5200);
  }
});

test('decide: clarifies ambiguous product, missing rate, bad quantity, currency', () => {
  const run = (o: Record<string, unknown>) => decide(ex(o) as never, seedCustomers(), seedItems(), opts);
  const amb = run({ customer: 'VK', items: [{ description: 'red wheel', quantity: 4, rate: null }] });
  assert.equal(amb.kind, 'clarify');
  assert.ok(amb.kind === 'clarify' && amb.options.length >= 2 && /Rate/.test(amb.question));
  assert.deepEqual(run({ customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 0, rate: 5200 }] }).trace.problems, ['invalid_quantity']);
  assert.deepEqual(run({ customer: null, items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5200 }] }).trace.problems, ['missing_customer']);
  assert.deepEqual(run({ customer: 'VK', currency: 'USD', items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5200 }] }).trace.problems, ['currency_mismatch']);
  assert.equal(run({ intent: 'non_invoice' }).kind, 'ignore');
  assert.equal(run({ intent: 'unsupported_followup', refers_to_previous_invoice: true }).kind, 'respond');
});

test('decide: item_default rate policy uses the Zoho item rate', () => {
  const d = decide(ex({ customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 4, rate: null }] }) as never, seedCustomers(), seedItems(), {
    ...opts,
    ratePolicy: 'item_default',
  });
  assert.ok(d.kind === 'create' && d.lines[0]!.rate === 5200 && d.lines[0]!.rateSource === 'item_default');
});

test('processor: creates draft invoice and ignores duplicate delivery', async () => {
  const { processor, books, sent } = setup(scripted({ [VK_REQUEST]: VK_EX }));
  const m = msg(VK_REQUEST);
  const r1 = await processor.handle(m);
  assert.equal(r1.action, 'created');
  assert.match(sent[0]!.out.text, /Draft invoice created: MOCK-INV-00001[\s\S]*VK Enterprises[\s\S]*4 × ₹5,200 = ₹20,800/);
  const r2 = await processor.handle(m);
  assert.equal(r2.action, 'duplicate');
  assert.equal(books.createCalls, 1);
});

test('processor: idempotency reference prevents re-creating after dedupe state is lost', async () => {
  const a = setup(scripted({ [VK_REQUEST]: VK_EX }));
  const m = msg(VK_REQUEST);
  await a.processor.handle(m);
  const b = setup(scripted({ [VK_REQUEST]: VK_EX }), { books: a.books });
  const r = await b.processor.handle(m);
  assert.equal(r.action, 'existing');
  assert.equal(a.books.createCalls, 1);
  assert.equal(idempotencyKey(m.chatId, m.id), a.books.invoices[0]!.reference);
});

test('processor: ignores own and non-invoice messages without replying', async () => {
  const { processor, sent } = setup(scripted({ 'ok thanks': ex({ intent: 'non_invoice' }) }));
  assert.equal((await processor.handle(msg('ok thanks'))).action, 'ignore');
  assert.equal((await processor.handle(msg('anything', { fromMe: true }))).action, 'ignore');
  assert.equal(sent.length, 0);
});

test('processor: clarification by option number, then create', async () => {
  const { processor, books, sent } = setup(
    scripted({ 'VK red wheel 4 rate 5200': ex({ customer: 'VK', items: [{ description: 'red wheel', quantity: 4, rate: 5200 }] }) }),
  );
  const r1 = await processor.handle(msg('VK red wheel 4 rate 5200'));
  assert.equal(r1.action, 'clarify');
  assert.equal(books.createCalls, 0);
  const question = sent[0]!;
  const options = r1.decision!.kind === 'clarify' ? r1.decision!.options : [];
  const pick = options.findIndex((o) => o.name === 'Lenzo Alloy Wheel 18" Red') + 1;
  assert.ok(pick > 0);
  const r2 = await processor.handle(msg(String(pick), { quotedId: question.id }));
  assert.equal(r2.action, 'created');
  assert.equal(books.invoices[0]!.lines[0]!.name, 'Lenzo Alloy Wheel 18" Red');
});

test('processor: clarification answered in text is merged by the model', async () => {
  const { processor, books } = setup(
    scripted({
      'VK lenzo 18 red x 4': ex({ customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 4, rate: null }] }),
      '5200': ex({ intent: 'clarification_response', customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5200 }] }),
    }),
  );
  assert.equal((await processor.handle(msg('VK lenzo 18 red x 4'))).action, 'clarify');
  const r = await processor.handle(msg('5200'));
  assert.equal(r.action, 'created');
  assert.equal(books.invoices[0]!.total, 24544);
});

test('processor: expired clarification is not associated', async () => {
  let now = 1_000_000;
  const { processor, books, sent } = setup(
    scripted({
      'VK lenzo 18 red x 4': ex({ customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 4, rate: null }] }),
    }),
    { now: () => now },
  );
  await processor.handle(msg('VK lenzo 18 red x 4'));
  now += 16 * 60_000;
  const r = await processor.handle(msg('5200', { quotedId: sent[0]!.id }));
  assert.equal(r.action, 'respond');
  assert.equal(r.reason, 'expired_clarification');
  assert.equal(books.createCalls, 0);
});

test('processor: other sender without quote does not hijack a pending clarification', async () => {
  const { processor, books } = setup(
    scripted({
      'VK lenzo 18 red x 4': ex({ customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 4, rate: null }] }),
      '5200': ex({ intent: 'non_invoice' }),
    }),
  );
  await processor.handle(msg('VK lenzo 18 red x 4'));
  const r = await processor.handle(msg('5200', { senderId: 'bob@s.whatsapp.net' }));
  assert.equal(r.associatedPending, false);
  assert.equal(books.createCalls, 0);
});

test('processor: dry run never creates', async () => {
  const { processor, books, sent } = setup(scripted({ [VK_REQUEST]: VK_EX }), { dryRun: true });
  assert.equal((await processor.handle(msg(VK_REQUEST))).action, 'dry_run');
  assert.equal(books.createCalls, 0);
  assert.match(sent[0]!.out.text, /DRY RUN/);
});

test('processor: model failure is reported, nothing created', async () => {
  const { processor, books } = setup(scripted({}));
  const r = await processor.handle(msg('VK lenzo 18 x 4'));
  assert.equal(r.action, 'error');
  assert.equal(books.createCalls, 0);
});

test('processor: a failed reply does not turn a created invoice into an error', async () => {
  const { processor, books } = setup(scripted({ [VK_REQUEST]: VK_EX }));
  (processor as unknown as { deps: { send: () => Promise<never> } }).deps.send = async () => {
    throw new Error('WhatsApp send failed (HTTP 401)');
  };
  const r = await processor.handle(msg(VK_REQUEST));
  assert.equal(r.action, 'created');
  assert.equal(books.createCalls, 1);
});

test('grounding: numbers must come from the message; one rate cannot silently cover several items', async () => {
  const { numbersIn } = await import('../src/pipeline/grounding.js');
  assert.deepEqual(numbersIn('x4 @ ₹5,200, 5.6k, four'), [4, 5200, 5600, 4]);
  const run = (o: Record<string, unknown>, sourceText: string) => decide(ex(o) as never, seedCustomers(), seedItems(), { ...opts, sourceText });
  const b05 = run(
    { customer: 'Metro', items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5200 }, { description: 'neo 16 red', quantity: 2, rate: 5200 }] },
    'Metro - 4 lenzo 18 red, 2 neo 16 red, rate 5200',
  );
  assert.equal(b05.kind, 'clarify');
  assert.ok(b05.trace.problems.includes('shared_rate'));
  const both = run(
    { customer: 'Metro', items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5200 }, { description: 'lenzo 18 black', quantity: 2, rate: 5200 }] },
    'Metro - 4 lenzo 18 red, 2 lenzo 18 black, both 5200',
  );
  assert.equal(both.kind, 'create');
  const invented = run({ customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5200 }] }, 'VK lenzo 18 red x 4');
  assert.deepEqual(invented.trace.problems, ['ungrounded_rate']);
  assert.equal(run({ customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5600 }] }, 'VK lenzo 18 red four pcs 5.6k').kind, 'create');
});

test('decide: null item description asks which item instead of failing', () => {
  const parsed = parseExtraction('{"intent":"invoice_request","customer":"VK","items":[{"description":null,"quantity":6}]}');
  assert.ok(parsed.ok);
  const d = decide(parsed.value, seedCustomers(), seedItems(), opts);
  assert.equal(d.kind, 'clarify');
  assert.ok(d.trace.problems.includes('missing_item'));
});
