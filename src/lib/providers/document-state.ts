import { CREDIT_NOTE_TYPE_CODE, type InvoiceStatusCode } from './dto';

/**
 * What a provider's document is, the one reading every mapper asks for. The
 * mappers read the facts off their own wire format; the rule that decides what
 * those facts mean lives here, so a fix reaches every provider and both
 * registers:
 *
 *   - what a document is outranks its amounts: a voided document is cancelled
 *     and an unissued one a draft, whatever its balance says;
 *   - a document is a credit note when the provider flags it as one, or when
 *     its payable total is negative;
 *   - an unissued credit note is a credit note, and stays a draft: it has
 *     reduced nothing yet.
 *
 * The negative total is not a guess: a sales document that owes the customer
 * money cannot be a claim on them, and a supplier document that owes US money
 * cannot be a payable, whatever the source system calls it. It is the only
 * signal several payloads carry at all (Fortnox's list form has no `Credit`
 * field; Briox, Björn Lundén and WINT document no credit flag this code could
 * be verified against; Bokio's supplier invoice has none). It is also what
 * keeps a wrong guess about a flag's wire format from failing silently: the
 * Fortnox mapper tested `Credit === true` while Fortnox's schema types the
 * flag as the string "true", and 3 200 credit notes reached production as paid
 * invoices without a single one ever reading as credited (#2789). The supplier
 * side had the mirror defect: about 40 supplier credit notes reached
 * production as ordinary invoices with a negative total (#2838).
 */
export interface DocumentFacts {
  /**
   * False when the source states the document never went out. Only a stated
   * fact counts: a payload that says nothing leaves this true and the
   * provider's other signals decide, because a wrong draft is the expensive
   * way round (an issued invoice read as a draft is booked again by Skicka).
   */
  issued: boolean;
  /**
   * The provider says money moved on this document, in full or in part: a
   * payment enum or flag, never a balance. That says the document went out,
   * whatever else its status claims, unless there is no amount to pay.
   */
  paymentStated?: boolean;
  /** The source voided it (makulerad, deleted). */
  cancelled: boolean;
  /**
   * The provider says this document IS a credit note. A status saying it HAS
   * BEEN credited (Bokio `credited`, WINT `CreditStatus`) describes the
   * original and must not be passed here: typing the original 381 would
   * reverse the sign of a real receivable.
   */
  creditFlag: boolean;
  /** The payable total as the provider states it. */
  total: number;
}

export interface DocumentState {
  /**
   * 381 for a credit note, nothing for an ordinary invoice: the one signal the
   * importer reads (dto.ts).
   */
  invoiceTypeCode: typeof CREDIT_NOTE_TYPE_CODE | undefined;
  /**
   * What the document's nature settles. Null for an issued, ordinary invoice:
   * its status comes from the provider's lifecycle and payment fields.
   */
  status: Extract<InvoiceStatusCode, 'cancelled' | 'draft' | 'credited'> | null;
}

export function documentState({ issued, paymentStated, cancelled, creditFlag, total }: DocumentFacts): DocumentState {
  const invoiceTypeCode = creditFlag || total < 0 ? CREDIT_NOTE_TYPE_CODE : undefined;
  if (cancelled) return { invoiceTypeCode, status: 'cancelled' };
  if (!issued && !(paymentStated && total !== 0)) return { invoiceTypeCode, status: 'draft' };
  return { invoiceTypeCode, status: invoiceTypeCode ? 'credited' : null };
}

/** A document's payment fields as a mapper read them. */
export interface StatedPayment {
  paid: boolean;
  balance: number;
}

/**
 * What the payment fields may say about this document. An unissued document
 * has been invoiced to nobody, so nothing can have been settled and it owes
 * its whole total: a balance reading 0 on it (a zero total, a stale field) is
 * not a payment, and every field that says so is ignored.
 */
export function documentPayment(document: DocumentState, total: number, stated: StatedPayment): StatedPayment {
  return document.status === 'draft' ? { paid: false, balance: total } : stated;
}
