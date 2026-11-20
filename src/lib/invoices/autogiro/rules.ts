/**
 * The rules an Autogiro debit has to keep, pure so the page, the routes and
 * the file writer agree.
 *
 * Source: Bankgirot, "Bg Autogiro Användarmanual" (december 2025):
 *   - 3.2.2: the payer is told the amount and the day at least eight banking
 *     days before the payment day; an ordinary invoice that says the amount
 *     is debited by Autogiro is that notice.
 *   - 3.3 (tidsgränser): a payment file reaches Bankgirot by 19.00 the banking
 *     day before the first payment day, so the earliest payment day is the
 *     first banking day after today.
 *   - 3.3.3: a payment day that is not a banking day runs the next one.
 * Bg Autogiro Teknisk manual (november 2021) 7.3: the payer number is up to 16
 * digits and the reference (here the invoice's OCR) up to 16 characters.
 */
import { addDaysIso } from '@/lib/dates/iso'
import { earliestExecutionDateIso, nextBankDayIso } from '@/lib/payments/bank-days'

/** Banking days of notice the payer gets before the payment day. */
export const NOTICE_BANKING_DAYS = 8

/** The longest reference Bankgirot carries back in its reports. */
export const MAX_REFERENCE_LENGTH = 16

/** A payer number as Bankgirot treats it: digits only, without leading zeros. Null when it is not 1-16 digits. */
export function normalizePayerNumber(input: string | null | undefined): string | null {
  const digits = (input ?? '').replace(/[\s-]/g, '')
  if (!/^\d{1,16}$/.test(digits)) return null
  return digits.replace(/^0+(?=\d)/, '')
}

/** The `count`-th banking day after the given day (the day itself never counts). */
export function addBankingDays(iso: string, count: number): string {
  let day = iso
  for (let i = 0; i < count; i++) day = nextBankDayIso(addDaysIso(day, 1))
  return day
}

/**
 * The payment day of an invoice's debit: its due date (moved to a banking
 * day), but never before the payer has had eight banking days' notice from
 * the day the invoice went out, and never before the first banking day after
 * today.
 */
export function debitDateFor(input: { dueDate: string; noticeDate: string; today: string }): string {
  const candidates = [
    nextBankDayIso(input.dueDate),
    addBankingDays(input.noticeDate, NOTICE_BANKING_DAYS),
    earliestExecutionDateIso(input.today),
  ]
  return candidates.sort()[candidates.length - 1]!
}

/** The debit's reference: the invoice's OCR when it fits Bankgirot's field, else null. */
export function debitReference(ocr: string): string | null {
  return /^\d{2,16}$/.test(ocr) && ocr.length <= MAX_REFERENCE_LENGTH ? ocr : null
}
