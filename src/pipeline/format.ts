import type { Invoice } from '../types.js';
import { fmtMoney, type ResolvedLine } from './decide.js';

export function invoiceSummary(inv: Invoice, heading: string): string {
  const lines = inv.lines.map((l, i) => `${i + 1}. ${l.name} — ${l.quantity} × ${fmtMoney(l.rate)} = ${fmtMoney(l.amount)}`);
  return [
    `${heading} ${inv.number}`,
    `Customer: ${inv.customerName}`,
    ...lines,
    `Subtotal: ${fmtMoney(inv.subTotal)}`,
    `Tax: ${fmtMoney(inv.taxTotal)}`,
    `Total: ${fmtMoney(inv.total)}${inv.currency && inv.currency !== 'INR' ? ` ${inv.currency}` : ''}`,
    `Status: ${inv.status}${inv.status === 'draft' ? ' (not sent to customer)' : ''}`,
    ...(inv.url ? [`Link: ${inv.url}`] : []),
  ].join('\n');
}

export function dryRunSummary(customerName: string, lines: ResolvedLine[], defaultTaxPercent?: number): string {
  const sub = lines.reduce((s, l) => s + l.quantity * l.rate, 0);
  const pct = (l: ResolvedLine) => (l.item.taxId || l.item.taxPercentage ? l.item.taxPercentage : defaultTaxPercent);
  const knownTax = lines.every((l) => pct(l) !== undefined);
  const tax = lines.reduce((s, l) => s + (l.quantity * l.rate * (pct(l) ?? 0)) / 100, 0);
  return [
    'DRY RUN: no invoice was created. Would create draft invoice:',
    `Customer: ${customerName}`,
    ...lines.map((l, i) => `${i + 1}. ${l.item.name} — ${l.quantity} × ${fmtMoney(l.rate)} = ${fmtMoney(l.quantity * l.rate)}${l.rateSource === 'item_default' ? ' (list rate)' : l.rateSource === 'previous_invoice' ? ' (previous invoice rate)' : ''}`),
    `Subtotal: ${fmtMoney(sub)}`,
    knownTax ? `Estimated tax: ${fmtMoney(tax)} (Zoho calculates the final tax)` : 'Tax: calculated by Zoho on creation',
  ].join('\n');
}
