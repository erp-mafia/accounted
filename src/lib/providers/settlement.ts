import { roundOre } from '@/lib/money';
import type { InvoiceStatusCode, PaymentStatusDto } from './dto';

/** What a provider's payment fields say, as the columns an invoice row carries. */
export interface InvoiceSettlement {
  /**
   * The status the payment state implies, or null when it implies nothing
   * and the row keeps its lifecycle status.
   */
  status: 'paid' | 'partially_paid' | null;
  paidAmount: number;
  remainingAmount: number;
  /**
   * The day the provider says the invoice was paid in full, or null: on any
   * row that is not, and when the provider gave no date (Fortnox never does).
   * A part payment has none, as natively (settle-invoice-payment.ts,
   * settle-supplier-payment.ts). Never derived from the invoice date: an
   * unknown date stays unknown (#2719).
   */
  paidAt: string | null;
}

/** Nothing collected, nothing owed: a kreditfaktura, a voided document. */
export const NOTHING_SETTLED: InvoiceSettlement = { status: null, paidAmount: 0, remainingAmount: 0, paidAt: null };

/**
 * The balance to trust. A provider hands over two independent signals, the
 * paid flag and the remaining balance, and they can disagree. When the flag
 * came from the provider's explicit payment-status enum
 * (paymentStatus.source === 'enum') and says NOT settled, a non-positive
 * balance beside it is a payload artefact rather than a settlement, so the
 * open balance is the total. Company 5208b894 (Visma, 2026-09-10) imported all
 * 53 of its unpaid supplier invoices as paid with remaining_amount 0 because
 * the zero balance was combined with the flag by OR. Without an enum the
 * balance keeps its drift-tolerant meaning: a residual öre resolves to paid.
 */
function trustedBalance(paymentStatus: PaymentStatusDto, total: number): number {
  const balance = roundOre(paymentStatus.balance.value);
  if (paymentStatus.source === 'enum' && !paymentStatus.paid && balance <= 0) return total;
  return balance;
}

/**
 * One reading of paid, part paid and open for a provider's invoice, on either
 * register: the import, and the repair pass that refreshes payment state from
 * the provider afterwards (refresh-migrated-payment-state.ts), so the status,
 * paid_amount and remaining_amount of a row never contradict each other and a
 * repair never contradicts the import it repairs.
 *
 * What the document is comes first: a voided one neither collected nor owes
 * anything, and an original the source credited stays credited whatever its
 * money fields say. Otherwise it is settled when the provider says so, by its
 * paid flag or its lifecycle status, and those win over the amounts: a row
 * reading paid beside money still open is the contradiction this rule exists
 * to remove.
 *
 * A draft has no branch here. A document the source states it never issued
 * reaches this with nothing paid and its whole total open (documentPayment),
 * and a 'draft' that is only a mapper's last fallback keeps the money its
 * fields state: the fallback says nothing about the document.
 *
 * The balance may declare a settlement on its own only when there is an
 * amount to settle and no enum spoke. `total > 0` is the part Bokio needed:
 * its API returns totalAmount 0 for invoices older than the register it
 * exposes, and a zero balance beside a zero total is an amount-less record,
 * not a payment (384 such rows across two migrated companies were written as
 * "paid" for 0 kr on 2026-09-14). An explicit paid = false from an enum is
 * never overridden by a zero either: see trustedBalance. Balances are read
 * numerically, never strict === 0, so floating drift or a residual öre
 * resolves cleanly to paid or unpaid.
 *
 * The caller decides a kreditfaktura first: nothing is ever collected on one
 * (NOTHING_SETTLED), since it reduces what is owed rather than settling it.
 */
export function resolveInvoiceSettlement(
  paymentStatus: PaymentStatusDto,
  lifecycleStatus: InvoiceStatusCode,
  total: number,
): InvoiceSettlement {
  if (lifecycleStatus === 'cancelled') return NOTHING_SETTLED;

  const balance = trustedBalance(paymentStatus, total);
  const settled =
    paymentStatus.paid ||
    lifecycleStatus === 'paid' ||
    (balance <= 0 && total > 0 && paymentStatus.source !== 'enum');
  const paidAmount = settled ? total : Math.max(0, roundOre(total - balance));
  const partial = paidAmount > 0 && paidAmount < total;

  return {
    status: lifecycleStatus === 'credited' ? null : settled ? 'paid' : partial ? 'partially_paid' : null,
    paidAmount,
    remainingAmount: settled ? 0 : Math.max(0, balance),
    paidAt: settled ? paymentStatus.lastPaymentDate || null : null,
  };
}
