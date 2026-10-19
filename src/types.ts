export interface Customer {
  id: string;
  name: string;
  companyName?: string;
  aliases: string[];
  currency?: string;
  active: boolean;
}

export interface Item {
  id: string;
  name: string;
  sku?: string;
  rate: number;
  unit?: string;
  taxId?: string;
  taxPercentage?: number;
  active: boolean;
}

export interface InvoiceLineInput {
  itemId: string;
  quantity: number;
  rate: number;
}

export interface InvoiceInput {
  customerId: string;
  referenceNumber: string;
  lines: InvoiceLineInput[];
  notes?: string;
}

export interface Invoice {
  id: string;
  number: string;
  status: string;
  customerName: string;
  currency: string;
  subTotal: number;
  taxTotal: number;
  total: number;
  url?: string;
  customerId?: string;
  date?: string;
  lines: { itemId?: string; name: string; quantity: number; rate: number; amount: number }[];
}

export interface PreviousRate {
  rate: number;
  invoiceNumber: string;
  date: string;
}

/** Narrow interface over Zoho Books so the pipeline can run against a mock. */
export interface BooksApi {
  listCustomers(): Promise<Customer[]>;
  listItems(): Promise<Item[]>;
  findInvoiceByReference(referenceNumber: string): Promise<Invoice | null>;
  createInvoice(input: InvoiceInput): Promise<Invoice>;
  getInvoicePdf(invoiceId: string): Promise<Buffer | null>;
  getInvoice(invoiceId: string): Promise<Invoice>;
  /** Most recent issued (not draft, not void) invoice line for this customer and item, used for "rate same as last time". */
  findLastRate(customerId: string, itemId: string): Promise<PreviousRate | null>;
  /** Replaces the line items of an existing invoice (used only for drafts created by this bot). */
  updateInvoiceLines(invoiceId: string, customerId: string, lines: InvoiceLineInput[]): Promise<Invoice>;
  /** Creates a customer contact. Only called after an explicit user confirmation. */
  createCustomer(name: string): Promise<Customer>;
}

export interface IncomingMessage {
  id: string;
  chatId: string;
  senderId: string;
  text: string;
  timestamp: number;
  fromMe: boolean;
  quotedId?: string;
}

export interface Outgoing {
  text: string;
  document?: { data: Buffer; fileName: string; mimetype: string };
  /** Optional tap-to-choose buttons (rows). Transports without button support ignore them; the text stays self-sufficient. */
  buttons?: { text: string; data: string }[][];
}

/** Sends a message to a chat, optionally quoting a message; returns the sent message id when known. */
export type SendFn = (chatId: string, out: Outgoing, quoteId?: string) => Promise<string | undefined>;
