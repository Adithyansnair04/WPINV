import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, requireZohoCredentials } from '../config.js';
import { createLogger } from '../logger.js';
import { ZohoBooks } from '../zoho/client.js';

/**
 * Creates the synthetic seed customers/items in a Zoho Books TRIAL organization, skipping names that already exist.
 * Usage: npm run zoho:seed -- --confirm [--gst-treatment business_none]
 */
const { values } = parseArgs({ options: { confirm: { type: 'boolean' }, 'gst-treatment': { type: 'string' } } });
const cfg = loadConfig();
const creds = requireZohoCredentials(cfg);
const customers = JSON.parse(readFileSync('data/seed/customers.json', 'utf8')) as { name: string; company: string; city: string }[];
const items = JSON.parse(readFileSync('data/seed/items.json', 'utf8')) as { name: string; sku: string; rate: number; hsn: string }[];

if (!values.confirm) {
  console.log(`Would create up to ${customers.length} customers and ${items.length} items in org ${creds.orgId}. Re-run with --confirm.`);
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
console.log('Done. Set GST/tax preferences on items in the Zoho UI if your org is GST-registered, then run npm run zoho:check.');
