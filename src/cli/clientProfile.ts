import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createBooks } from '../app.js';
import { draftProfile, profileCatalogue, renderReport } from '../clients/onboard.js';
import { normalizerFor } from '../clients/profile.js';
import { pickClient } from '../clients/registry.js';
import { createLogger } from '../logger.js';

/**
 * Onboarding report for a client whose customers and items we don't know yet.
 * Usage: npm run client:profile -- --client acme [--write] [--business "an Indian stationery wholesaler"]
 * Reads the client's Zoho catalogue (read-only), writes clients/<id>/onboarding-report.md, and with --write
 * creates a draft clients/<id>/profile.json if the profile is still the empty template.
 */
const { values } = parseArgs({ options: { client: { type: 'string' }, write: { type: 'boolean' }, business: { type: 'string' } } });

async function main(): Promise<number> {
  const client = pickClient(values.client);
  if (client.error) {
    console.error(`Client "${client.id}" is misconfigured: ${client.error}`);
    return 1;
  }

  const books = createBooks(client.cfg, createLogger('warn'), client.profile);
  const [customers, items] = await Promise.all([books.listCustomers(), books.listItems()]);
  const report = profileCatalogue(customers, items, normalizerFor(client.profile));

  const dir = join('clients', client.id);
  mkdirSync(dir, { recursive: true });
  const reportFile = join(dir, 'onboarding-report.md');
  writeFileSync(reportFile, renderReport(report, client.name));
  console.log(`${client.name}: ${report.customers.active} customers, ${report.items.active} items (${client.cfg.ZOHO_MODE} Zoho)`);
  console.log(`  look-alike item groups: ${report.lookAlikes.length}, indistinguishable: ${report.indistinguishable.length}`);
  console.log(`  customer words shared by several customers: ${report.sharedCustomerWords.length}, initials collisions: ${report.initialsCollisions.length}`);
  console.log(`Report: ${reportFile}`);

  if (values.write) {
    const profileFile = join(dir, 'profile.json');
    const isTemplate = !existsSync(profileFile) || /"business":\s*"TODO/.test(readFileSync(profileFile, 'utf8'));
    const draft = JSON.stringify(draftProfile(report, values.business), null, 2) + '\n';
    if (isTemplate) {
      writeFileSync(profileFile, draft);
      console.log(`Draft profile: ${profileFile} (review it; set "profile" for this client in clients.json if not already)`);
    } else {
      console.log(`${profileFile} already has a reviewed profile; not overwritten. Suggested draft:\n${draft}`);
    }
  }
  return 0;
}

process.exitCode = await main().catch((e) => {
  console.error(`client:profile failed: ${(e as Error).message}`);
  return 1;
});
