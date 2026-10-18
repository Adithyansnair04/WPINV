import { readFileSync, writeFileSync } from 'node:fs';

/** Writes Zoho-importable CSVs from the JSON seed data (Contacts > Import, Items > Import). */
const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';

const customers = JSON.parse(readFileSync('data/seed/customers.json', 'utf8')) as { name: string; company: string; city: string }[];
const items = JSON.parse(readFileSync('data/seed/items.json', 'utf8')) as { name: string; sku: string; rate: number; hsn: string; tax_percentage: number }[];

writeFileSync('data/seed/customers.csv', csv([['Display Name', 'Company Name', 'Contact Type', 'Billing City'], ...customers.map((c) => [c.name, c.company, 'customer', c.city])]));
writeFileSync(
  'data/seed/items.csv',
  csv([['Item Name', 'SKU', 'Selling Price', 'Product Type', 'HSN/SAC', 'Intra State Tax Rate', 'Inter State Tax Rate'], ...items.map((i) => [i.name, i.sku, i.rate, 'goods', i.hsn, `GST${i.tax_percentage}`, `IGST${i.tax_percentage}`])]),
);
console.log('Wrote data/seed/customers.csv and data/seed/items.csv');
