import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { requireZohoCredentials } from '../config.js';
import { loadClients, pickClient } from '../clients/registry.js';
import { createLogger } from '../logger.js';
import { ZohoBooks } from '../zoho/client.js';

/**
 * Creates synthetic seed customers/items in a Zoho Books TRIAL organization, skipping names that already exist.
 * Usage: npm run zoho:seed -- [--client acme] [--data data/demo-clients/stationery] --confirm [--gst-treatment business_none] [--tax 18]
 * --data is a folder with customers.json and items.json (default: the wheels-and-tyres demo in data/seed).
 * --tax N also creates an N% tax ("GST N%") if the org has none, for DEFAULT_TAX_PERCENT.
 */
const { values } = parseArgs({
  options: { client: { type: 'string' }, data: { type: 'string' }, confirm: { type: 'boolean' }, 'gst-treatment': { type: 'string' }, tax: { type: 'string' } },
});
const clients = loadClients();
const client = pickClient(values.client, clients);
const creds = requireZohoCredentials(client.cfg);
const sharing = clients.filter((c) => c.id !== client.id && c.cfg.ZOHO_ORG_ID === creds.orgId).map((c) => c.id);
if (sharing.length) {
  console.error(`Org ${creds.orgId} also belongs to client(s) ${sharing.join(', ')}. Point ${client.id} at its own organization before seeding.`);
  process.exit(1);
}
const dataDir = values.data ?? 'data/seed';
const customers = JSON.parse(readFileSync(join(dataDir, 'customers.json'), 'utf8')) as { name: string; company: string; city: string }[];
const items = JSON.parse(readFileSync(join(dataDir, 'items.json'), 'utf8')) as { name: string; sku: string; rate: number; hsn: string }[];

if (!values.confirm) {
  console.log(`Would create up to ${customers.length} customers and ${items.length} items from ${dataDir} in org ${creds.orgId} (client ${client.id}). Re-run with --confirm.`);
  process.exit(0);
}

const zoho = new ZohoBooks(creds, { log: createLogger('warn') });
const existingC = new Set((await zoho.listCustomers()).map((c) => c.name));
const existingI = new Set((await zoho.listItems()).map((i) => i.name));

for (const c of customers) {
  if (existingC.has(c.name)) continue;
  await zoho.request('POST', '/contacts', {
    body: {
      contact_name: c.name,
      company_name: c.company,
      contact_type: 'customer',
      billing_address: { city: c.city },
      ...(values['gst-treatment'] ? { gst_treatment: values['gst-treatment'] } : {}),
    },
  });
  console.log(`customer created: ${c.name}`);
}
for (const i of items) {
  if (existingI.has(i.name)) continue;
  await zoho.request('POST', '/items', {
    body: { name: i.name, sku: i.sku, rate: i.rate, product_type: 'goods', item_type: 'sales', hsn_or_sac: i.hsn },
  });
  console.log(`item created: ${i.name}`);
}
if (values.tax) {
  const pct = Number(values.tax);
  if (await zoho.findTaxId(pct)) console.log(`tax ${pct}% already exists`);
  else {
    await zoho.request('POST', '/settings/taxes', { body: { tax_name: `GST ${pct}%`, tax_percentage: pct, tax_type: 'tax' } });
    console.log(`tax created: GST ${pct}%`);
  }
}
console.log('Done. Set GST/tax preferences on items in the Zoho UI if your org is GST-registered, then run npm run zoho:check.');
