import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CustomerMatcher, ItemMatcher } from '../src/matching/matcher.js';
import { AUTO_PARTS_NORMALIZER, GENERIC_NORMALIZER } from '../src/matching/normalize.js';

const normalizeText = (s: string) => AUTO_PARTS_NORMALIZER.normalizeText(s);
import { seedCustomers, seedItems } from '../src/zoho/mock.js';

const customers = new CustomerMatcher(seedCustomers(), AUTO_PARTS_NORMALIZER);
const items = new ItemMatcher(seedItems(), AUTO_PARTS_NORMALIZER);

const itemName = (q: string) => {
  const r = items.match(q);
  return r.status === 'matched' ? r.record.sku : r.status;
};
const customerName = (q: string) => {
  const r = customers.match(q);
  return r.status === 'matched' ? r.record.name : r.status;
};

test('normalizes sizes', () => {
  assert.equal(normalizeText('Lenzo 18" red'), 'lenzo 18in red');
  assert.equal(normalizeText('18 inch'), '18in');
  assert.equal(normalizeText('195/55 R16'), '195/55r16');
  assert.equal(normalizeText('195 55 16'), '195/55r16');
  assert.equal(normalizeText('Nut Set (16 pcs)'), 'nut set 16pcs');
  assert.equal(normalizeText('neo 16 red'), 'neo 16in red');
});

test('customer aliases, initials and typos', () => {
  assert.equal(customerName('VK'), 'VK Enterprises');
  assert.equal(customerName('vk entrprises'), 'VK Enterprises');
  assert.equal(customerName('VKS'), 'VKS Auto Spares');
  assert.equal(customerName('vkt'), 'Vijay Kumar Tyres');
  assert.equal(customerName('royl alloys'), 'Royal Alloys');
  assert.equal(customerName('Sharma Wheels & Tyres'), 'Sharma Wheels & Tyres');
  assert.equal(customerName('kwh'), 'Kerala Wheel Hub');
});

test('ambiguous or unknown customers are not guessed', () => {
  assert.equal(customerName('sharma'), 'ambiguous');
  assert.equal(customerName('ganesh'), 'ambiguous');
  assert.equal(customerName('Zebra Traders'), 'not_found');
});

test('items: exact variant, typo, synonyms', () => {
  assert.equal(itemName('red lenzo alloy 18 inch'), 'LNZ-18-RED');
  assert.equal(itemName('lenza 18 red'), 'LZA-18-RED');
  assert.equal(itemName('lenzzo red 17inch'), 'LNZ-17-RED');
  assert.equal(itemName('neo 17 chrome rims'), 'NEO-17-CHR');
  assert.equal(itemName('vortx 18 mat black'), 'VTX-18-MBK');
  assert.equal(itemName('blak wheel nuts'), 'NUT-16-BLK');
  assert.equal(itemName('apex 205/55r16'), 'APX-205-55-16');
  assert.equal(itemName('LNZ-18-SLV'), 'LNZ-18-SLV');
});

test('items: ambiguity and non-existent variants', () => {
  assert.equal(itemName('red wheel'), 'ambiguous');
  assert.equal(itemName('lenzo 18'), 'ambiguous');
  assert.equal(itemName('195/55 r16 tyre'), 'ambiguous');
  assert.notEqual(itemName('blue lenzo 18'), 'LNZ-18-RED');
  assert.notEqual(itemName('momo red 18 alloy'), 'LNZ-18-RED');
});

test('normalizer packs: auto-parts rules only apply to clients that enable them', () => {
  assert.equal(GENERIC_NORMALIZER.normalizeText('neo 16 red'), 'neo 16 red');
  assert.equal(GENERIC_NORMALIZER.normalizeText('12 bottles of 500 ml'), '12 bottles of 500 ml');
  assert.equal(GENERIC_NORMALIZER.normalizeText('195/55 R16'), '195/55 r16');
  assert.equal(AUTO_PARTS_NORMALIZER.normalizeText('12 bottles'), '12in bottles');
  assert.deepEqual(GENERIC_NORMALIZER.tokenize('rims'), ['rims']);
  assert.deepEqual(AUTO_PARTS_NORMALIZER.tokenize('rims'), ['wheel']);
});
