/**
 * The verifikat that booked a Fortnox supplier invoice, as the invoice names it.
 *
 * Fortnox names it in `Vouchers`: a list of references, each with Series,
 * Number, Year (Fortnox's financial-year id) and a ReferenceType. The one
 * with ReferenceType SUPPLIERINVOICE is the booking; the others are the
 * payments and accruals that came after it. The list form and the detail
 * form both carry `Vouchers`.
 *
 * A supplier invoice also has top-level VoucherSeries, VoucherNumber and
 * VoucherYear, but Fortnox fills them only in the response to the bookkeep
 * action, not when the invoice is read (the customer invoice is different:
 * its detail form carries them). Reading only those fields found no booking
 * voucher for any of 61,795 migrated supplier invoices, so none was linked to
 * the SIE verifikat that booked it and each one offered to be booked again.
 * They are read here only when `Vouchers` names no booking at all.
 *
 * Several SUPPLIERINVOICE references are not guessed between: null, the
 * same as none.
 */

/** The ReferenceType Fortnox gives the voucher that books a supplier invoice. */
const SUPPLIER_INVOICE_BOOKING_REFERENCE = 'SUPPLIERINVOICE';

/** The voucher's parts as Fortnox sent them; each caller parses them its own way. */
export interface FortnoxSupplierInvoiceVoucherParts {
  series: unknown;
  number: unknown;
  year: unknown;
}

function vouchersOf(raw: Record<string, unknown>): Array<Record<string, unknown> | null> {
  return Array.isArray(raw['Vouchers']) ? (raw['Vouchers'] as Array<Record<string, unknown> | null>) : [];
}

export function fortnoxSupplierInvoiceBookingParts(
  raw: Record<string, unknown>,
): FortnoxSupplierInvoiceVoucherParts | null {
  const bookings = vouchersOf(raw).filter(
    (voucher) => voucher?.['ReferenceType'] === SUPPLIER_INVOICE_BOOKING_REFERENCE,
  );
  if (bookings.length > 1) return null;
  const booking = bookings[0];
  if (booking) {
    return { series: booking['Series'], number: booking['Number'], year: booking['Year'] };
  }
  if (raw['VoucherNumber'] == null) return null;
  return { series: raw['VoucherSeries'], number: raw['VoucherNumber'], year: raw['VoucherYear'] };
}

/** The ReferenceType Fortnox gives a voucher that pays a supplier invoice. */
const SUPPLIER_INVOICE_PAYMENT_REFERENCE = 'SUPPLIERPAYMENT';

/** Every voucher that paid the invoice, as Fortnox names them in `Vouchers`. */
export function fortnoxSupplierInvoicePaymentParts(
  raw: Record<string, unknown>,
): FortnoxSupplierInvoiceVoucherParts[] {
  return vouchersOf(raw)
    .filter((voucher): voucher is Record<string, unknown> => voucher?.['ReferenceType'] === SUPPLIER_INVOICE_PAYMENT_REFERENCE)
    .map((voucher) => ({ series: voucher['Series'], number: voucher['Number'], year: voucher['Year'] }));
}

/**
 * The payment that booked a kontantmetod supplier invoice, for its file only.
 *
 * Under kontantmetoden (BFL 5 kap 2 § tredje stycket) Fortnox books a
 * supplier invoice when it is paid: cost, VAT and bank go on the payment
 * voucher, and the invoice names no SUPPLIERINVOICE voucher at all. That
 * payment verifikat records the purchase, and the received invoice is its
 * verifikation (BFL 5 kap 6 §), so the invoice's file belongs on it.
 *
 * This is the candidate only: the invoice's one payment when it names no
 * SUPPLIERINVOICE voucher (a booking that fortnoxSupplierInvoiceBookingParts
 * could not single out is never replaced by a payment), null otherwise. The
 * caller takes it only when the payment's financial year is kontantmetod,
 * the invoice is settled to the öre and Fortnox does not mark it booked, so a
 * faktureringsmetod payment, a first instalment, a part refund of a credit
 * note or a payment Fortnox later took back never gets the file.
 *
 * Never the invoice's registration: the migration's registration link reads
 * the booking alone.
 */
export function fortnoxSupplierInvoiceCashBookingParts(
  raw: Record<string, unknown>,
): FortnoxSupplierInvoiceVoucherParts | null {
  if (vouchersOf(raw).some((voucher) => voucher?.['ReferenceType'] === SUPPLIER_INVOICE_BOOKING_REFERENCE)) {
    return null;
  }
  const payments = fortnoxSupplierInvoicePaymentParts(raw);
  return payments.length === 1 ? payments[0]! : null;
}
