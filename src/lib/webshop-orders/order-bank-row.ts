import type { SupabaseClient } from '@supabase/supabase-js'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { bankRowRefusalCode, decideBankRowRebooking, type GatedBankRow } from '@/lib/transactions/is-booked'
import { linkTransactionToJournalEntry } from '@/lib/transactions/link-journal-entry'
import { bankLegRoom, booksDirection } from '@/lib/transactions/voucher-bank-leg'
import type { CreateJournalEntryLineInput, WebshopOrder } from '@/types'

/**
 * The bank row a webshop order's booking links to in the same act
 * (transaction_id on webshop-orders.book, crm#1993): the Swish payment on
 * 1930 with the order number in its reference, or the Stripe charge on
 * 1686. checkOrderBankRow runs before anything is posted, on the dry run
 * and at the approval alike; linkOrderBankRow runs after the verifikat is
 * posted, through the link door every other caller uses
 * (linkTransactionToJournalEntry, lib/transactions/link-journal-entry.ts).
 */

/** The row as the approver sees it in the staged preview. */
export interface OrderBankRow {
  transactionId: string
  date: string
  /** Signed like the bank: + money in (an order), - money out (a refund). */
  amount: number
  currency: string
  description: string | null
  /** The ledger account the row settles on (its cash account's). */
  accountNumber: string
}

export type OrderBankRowCheck =
  | { ok: true; row: OrderBankRow }
  | { ok: false; code: string; details: Record<string, unknown> }

const ROW_COLUMNS =
  'id, date, amount, currency, description, merchant_name, cash_account_id, journal_entry_id, reconciliation_method, is_ignored, transaction_voucher_links(journal_entry_id, role)'

type OrderBankRowRead = GatedBankRow & {
  date: string
  amount: number | string
  currency: string | null
  description: string | null
  merchant_name: string | null
  cash_account_id: string | null
}

/**
 * The order's payment in the row's currency: the order's own amount when the
 * row is in the order's currency, its kronor amount when the row is in SEK,
 * null when the row is in a third currency. Signed like the order row (a
 * refund is negative), which is the bank's sign for the same money.
 */
function orderPaymentIn(order: Pick<WebshopOrder, 'currency' | 'total' | 'total_sek'>, currency: string): number | null {
  if (currency === order.currency.toUpperCase()) return roundOre(order.total)
  if (isKronorCurrency(currency) && order.total_sek !== null) return roundOre(order.total_sek)
  return null
}

/**
 * May this bank row be linked to the verifikat these lines will post for
 * the order? Refused unless the row is the company's, open by the gate every
 * booking door shares (decideBankRowRebooking: not booked, not linked, not
 * ignored), its amount is the order's payment in the row's currency, and the
 * lines book exactly that amount on the row's own account in the row's
 * direction (what the link door checks on the posted verifikat). `order` has
 * its exchange rate resolved (resolveOrderFx).
 */
export async function checkOrderBankRow(
  supabase: SupabaseClient,
  companyId: string,
  order: WebshopOrder,
  lines: CreateJournalEntryLineInput[],
  transactionId: string,
  log: Logger,
): Promise<OrderBankRowCheck> {
  const { data, error } = await supabase
    .from('transactions')
    .select(ROW_COLUMNS)
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) {
    log.warn('webshop order bank row could not be read', { transactionId, error: error.message })
    return { ok: false, code: 'BANK_ROW_READ_FAILED', details: { transaction_id: transactionId } }
  }
  if (!data) return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND', details: { transaction_id: transactionId } }
  const tx = data as unknown as OrderBankRowRead

  const rebooking = await decideBankRowRebooking(supabase, companyId, tx, { replace: false })
  if (rebooking.outcome === 'refuse') {
    return {
      ok: false,
      code: bankRowRefusalCode(rebooking, 'LINK_TX_TX_ALREADY_LINKED'),
      details: {
        transaction_id: transactionId,
        journal_entry_id: rebooking.journalEntryId,
        voucher: rebooking.voucher,
        via: rebooking.via,
      },
    }
  }

  const currency = (tx.currency || 'SEK').toUpperCase()
  const amount = roundOre(Number(tx.amount))
  const expected = orderPaymentIn(order, currency)
  if (expected === null || expected !== amount) {
    return {
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_AMOUNT_MISMATCH',
      details: {
        transaction_id: transactionId,
        transaction_amount: amount,
        transaction_currency: currency,
        order_total: order.total,
        order_currency: order.currency,
        order_total_sek: order.total_sek,
      },
    }
  }

  let accountNumber: string
  try {
    accountNumber = await resolveSettlementAccount(supabase, companyId, tx.cash_account_id, log, currency)
  } catch (err) {
    const code = (err as { code?: string }).code
    log.warn('webshop order bank row account could not be resolved', { transactionId, code })
    return {
      ok: false,
      code: code === 'BANK_BOOKING_CURRENCY_MISMATCH' ? code : 'BANK_ROW_READ_FAILED',
      details: { transaction_id: transactionId, reason: (err as Error).message },
    }
  }

  // The link door asks the posted verifikat the same: a line on the row's
  // account in its direction. Asked of the lines here, the amount is the
  // row's to the öre, so the row is this order's payment and nothing else.
  const onAccount = lines.filter((line) => line.account_number === accountNumber)
  const room = bankLegRoom(onAccount, [], currency)
  const booked = amount > 0 ? room.bookedIn : room.bookedOut
  if (onAccount.length === 0 || !room.measurable || !booksDirection(room, amount) || booked !== amount) {
    return {
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_ACCOUNT_MISMATCH',
      details: {
        transaction_id: transactionId,
        account_number: accountNumber,
        transaction_amount: amount,
        lines_on_account: room.measurable ? booked : null,
      },
    }
  }

  return {
    ok: true,
    row: {
      transactionId,
      date: tx.date,
      amount,
      currency,
      description: tx.merchant_name || tx.description || null,
      accountNumber,
    },
  }
}

/** What became of the link after the verifikat was posted. */
export type OrderBankRowLink =
  | { transactionId: string; linked: true }
  | {
      transactionId: string
      linked: false
      /** The link door's refusal code, with its sentence in both languages. */
      code: string
      messageSv: string
      messageEn: string
      details?: Record<string, unknown>
    }

/**
 * Link the bank row to the order's posted verifikat through the link door.
 * Never throws and never undoes the booking: a refusal or a failure is
 * answered as linked: false with the door's code, so the caller reports it
 * and the row can be linked once its cause is fixed.
 */
export async function linkOrderBankRow(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  transactionId: string,
  journalEntryId: string,
  log: Logger,
): Promise<OrderBankRowLink> {
  let code: string
  let details: Record<string, unknown> | undefined
  try {
    const linked = await linkTransactionToJournalEntry(supabase, userId, companyId, { transactionId, journalEntryId })
    if (linked.ok) return { transactionId, linked: true }
    code = linked.code
    details = linked.details
  } catch (err) {
    code = 'LINK_TX_DB_ERROR'
    details = { reason: err instanceof Error ? err.message : String(err) }
  }
  log.warn('webshop order booked, but its bank row was not linked', { transactionId, journalEntryId, code })
  const entry = getErrorEntry(code)
  return {
    transactionId,
    linked: false,
    code,
    messageSv: entry?.message_sv ?? code,
    messageEn: entry?.message_en ?? code,
    ...(details ? { details } : {}),
  }
}
