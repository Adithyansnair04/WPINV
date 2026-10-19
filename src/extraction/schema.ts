import { z } from 'zod';

export const Intent = z.enum(['invoice_request', 'clarification_response', 'edit_request', 'non_invoice', 'unsupported_followup']);
export type Intent = z.infer<typeof Intent>;

// LLM output is untrusted: accept numeric strings like "5,200" but nothing else.
const num = z.preprocess((v) => {
  if (typeof v === 'string') {
    const s = v.replace(/[,₹\s]|rs\.?/gi, '');
    return s === '' ? null : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : v;
  }
  return v;
}, z.number().finite().nullable());

const text = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable());

export const ExtractedItem = z.object({
  description: text(200).default(null),
  quantity: num.default(null),
  rate: num.default(null),
  rate_from_previous: z.boolean().default(false),
});

export const Extraction = z.object({
  intent: Intent,
  customer: text(120).default(null),
  items: z.array(ExtractedItem).max(20).default([]),
  currency: text(10).default(null),
  refers_to_previous_invoice: z.boolean().default(false),
  notes: text(300).default(null),
  missing: z.array(z.string().max(60)).max(10).default([]),
  ambiguity: text(300).default(null),
});

export type ExtractedItem = z.infer<typeof ExtractedItem>;
export type Extraction = z.infer<typeof Extraction>;
