/**
 * What registering an already-booked invoice means on both ledgers (crm#1094):
 * the kundreskontra (register-booked-invoice.ts) and the leverantörsreskontra
 * (lib/supplier-invoices/register-booked.ts) take the same amounts and dates
 * from the old system's reskontra and check the verifikat the agent named the
 * same way. Only the rules that are genuinely the same live here; what a
 * verifikat must book is each ledger's own.
 */

import { z } from 'zod'
import { daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { descriptionMentionsReference } from './invoice-matching'

const wholeOre = (n: number) => Number.isFinite(n) && Math.abs(roundOre(n) - n) < 1e-9

/** A total or a remaining balance: positive, in whole öre. */
export const registeredAmountSchema = z
  .number()
  .positive('must be greater than 0')
  .refine(wholeOre, 'must be in whole öre (at most two decimals)')

/** The invoice's currency per the reskontra; the plans refuse anything but SEK. */
export const reskontraCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code such as SEK')

/**
 * The date and amount rules of a registration: the due date is not before the
 * invoice date, the remaining balance is not above the total, and a partly
 * paid invoice names the reskontra's date (balance_as_of), on or after the
 * invoice date and not in the future, because its paid part is a payment row
 * dated that day.
 */
export function refineRegistrationDatesAndAmounts(
  value: { invoice_date: string; due_date: string; total: number; remaining_amount?: number; balance_as_of?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.due_date < value.invoice_date) {
    ctx.addIssue({ code: 'custom', path: ['due_date'], message: 'Förfallodatum får inte vara före fakturadatum' })
  }
  if (value.remaining_amount !== undefined && value.remaining_amount > value.total + ORE_TOLERANCE) {
    ctx.addIssue({ code: 'custom', path: ['remaining_amount'], message: 'Kvarvarande saldo får inte vara större än fakturans totalbelopp' })
  }
  const partlyPaid = value.remaining_amount !== undefined
    && value.remaining_amount > 0
    && value.remaining_amount < value.total - ORE_TOLERANCE
  if (partlyPaid && !value.balance_as_of) {
    ctx.addIssue({ code: 'custom', path: ['balance_as_of'], message: 'Ange reskontrans datum (det datum kvarvarande saldo gäller) när fakturan är delvis betald' })
  }
  if (value.balance_as_of && value.balance_as_of < value.invoice_date) {
    ctx.addIssue({ code: 'custom', path: ['balance_as_of'], message: 'Reskontrans datum får inte vara före fakturadatum' })
  }
  if (value.balance_as_of && value.balance_as_of > todayIsoStockholm()) {
    ctx.addIssue({ code: 'custom', path: ['balance_as_of'], message: 'Reskontrans datum får inte ligga i framtiden' })
  }
}

/** The verifikat's name in messages: series and number, else the start of its id. */
export function registrationVoucherLabel(voucher: {
  id: string
  voucher_series: string | null
  voucher_number: number | null
}): string {
  return voucher.voucher_series && voucher.voucher_number != null
    ? `${voucher.voucher_series}${voucher.voucher_number}`
    : voucher.id.slice(0, 8)
}

/**
 * The date corridor the migration linker accepts between an invoice and its
 * verifikat (14 days before, 90 after). Outside it the verifikat is more
 * likely another year's invoice with the same number and amount: warned, not
 * refused, because the agent named the verifikat explicitly.
 */
const ENTRY_DATE_DAYS_BEFORE = 14
const ENTRY_DATE_DAYS_AFTER = 90

export interface VoucherCorroborationWarning {
  code: 'REGISTER_VOUCHER_TEXT' | 'REGISTER_VOUCHER_DATE'
  message_sv: string
  message_en: string
}

/**
 * Warnings, not refusals, when the verifikat does not look like the invoice's
 * own: none of its texts names any of `references` (the invoice number first,
 * which the message names), or it is dated outside the corridor.
 */
export function voucherCorroborationWarnings(args: {
  label: string
  entryDate: string
  invoiceDate: string
  texts: ReadonlyArray<string | null | undefined>
  references: ReadonlyArray<string | number | null | undefined>
}): VoucherCorroborationWarning[] {
  const { label, entryDate, invoiceDate, texts, references } = args
  const warnings: VoucherCorroborationWarning[] = []
  const named = references.some((reference) => texts.some((text) => descriptionMentionsReference(text, reference)))
  if (!named) {
    warnings.push({
      code: 'REGISTER_VOUCHER_TEXT',
      message_sv: `Verifikation ${label} nämner inte fakturanummer ${references[0]}: kontrollera att det är fakturans verifikation.`,
      message_en: `Verifikat ${label} does not mention invoice number ${references[0]}: check that it is this invoice's verifikat.`,
    })
  }
  const days = daysBetweenIso(invoiceDate, entryDate)
  if (days < -ENTRY_DATE_DAYS_BEFORE || days > ENTRY_DATE_DAYS_AFTER) {
    warnings.push({
      code: 'REGISTER_VOUCHER_DATE',
      message_sv: `Verifikation ${label} är daterad ${entryDate} men fakturan ${invoiceDate}: kontrollera att det är fakturans verifikation.`,
      message_en: `Verifikat ${label} is dated ${entryDate} but the invoice ${invoiceDate}: check that it is this invoice's verifikat.`,
    })
  }
  return warnings
}
