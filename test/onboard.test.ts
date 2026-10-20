import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftProfile, profileCatalogue, renderReport } from '../src/clients/onboard.js';
import { ProfileSchema } from '../src/clients/profile.js';
import { AUTO_PARTS_NORMALIZER, GENERIC_NORMALIZER } from '../src/matching/normalize.js';
import type { Customer, Item } from '../src/types.js';
import { seedCustomers, seedItems } from '../src/zoho/mock.js';

const cust = (name: string, active = true): Customer => ({ id: name, name, aliases: [], active });
const item = (name: string, rate = 10, sku?: string): Item => ({ id: name, name, rate, sku, active: true });

test('onboarding profiler: demo catalogue shows the known look-alikes and shared names', () => {
  const r = profileCatalogue(seedCustomers(), seedItems(), AUTO_PARTS_NORMALIZER);
  assert.equal(r.items.active, 20);
  assert.ok(r.lookAlikes.some((g) => g.base === '18in alloy lenzo wheel' && ['black', 'red', 'silver'].every((w) => g.variants.some((v) => v.word === w))));
  assert.deepEqual(r.sharedCustomerWords.find((w) => w.word === 'sharma')?.customers, ['Sharma Auto Parts', 'Sharma Wheels & Tyres']);
  assert.deepEqual(r.sharedCustomerWords.find((w) => w.word === 'ganesh')?.customers, ['Ganesh Wheel Care', 'Sri Ganesh Motors']);
  assert.equal(r.autoPartsLike, true);
  assert.deepEqual(r.indistinguishable, []);
});

test('onboarding profiler: an unknown stationery client gets generic rules, units and warnings', () => {
  const customers = [cust('Mehta Traders'), cust('Mehta Book Depot'), cust('Vidya Kendra'), cust('Vasant Kumar Stores'), cust('Old Account', false)];
  const items = [
    item('Classmate Notebook 200 Pages Ruled', 60, 'NB-200-R'),
    item('Classmate Notebook 200 Pages Unruled', 60, 'NB-200-U'),
    item('Reynolds Gel Pen Blue', 10),
    item('Reynolds Gel Pen Black', 10),
    item('Reynolds Gel Pen Red', 10),
    item('Camlin Ink 60 ml Blue', 45),
    item('A4 Copier Paper 75 gsm Ream', 0),
    item('Reynolds Gel Pen Blue', 12),
  ];
  const r = profileCatalogue(customers, items, GENERIC_NORMALIZER);
  assert.equal(r.customers.inactive, 1);
  assert.deepEqual(r.indistinguishable, [['Reynolds Gel Pen Blue', 'Reynolds Gel Pen Blue']]);
  assert.ok(r.lookAlikes.some((g) => g.base === 'gel pen reynolds' && g.variants.map((v) => v.word).sort().join() === 'black,blue,blue,red'));
  assert.ok(r.lookAlikes.some((g) => g.variants.some((v) => v.word === 'unruled')));
  assert.deepEqual(r.sharedCustomerWords.find((w) => w.word === 'mehta')?.customers, ['Mehta Book Depot', 'Mehta Traders']);
  assert.deepEqual(r.initialsCollisions, []);
  assert.deepEqual(r.units, [{ unit: 'ml', example: '60 ml' }]);
  assert.deepEqual(r.items.zeroRate, ['A4 Copier Paper 75 gsm Ream']);
  assert.equal(r.autoPartsLike, false);

  const draft = draftProfile(r, 'an Indian stationery wholesaler');
  assert.ok(ProfileSchema.safeParse(draft).success, 'the draft is a valid profile');
  assert.deepEqual(draft.normalizer.packs, []);
  assert.deepEqual(draft.aliases, {}, 'aliases are never invented');
  assert.match(draft.notQuantity!, /"60 ml"/);
  assert.match(renderReport(r, 'Acme Stationery'), /Mehta Book Depot \/ Mehta Traders/);
});

test('onboarding profiler: colliding initials are flagged', () => {
  const r = profileCatalogue([cust('Vijay Kumar'), cust('Vinod Kirana'), cust('Solo Shop')], [item('Pen')], GENERIC_NORMALIZER);
  assert.deepEqual(r.initialsCollisions, [{ initials: 'vk', customers: ['Vijay Kumar', 'Vinod Kirana'] }]);
});
