import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, DeductionType, JournalEntry } from '@/types'
import { ORE_ROUNDING_ACCOUNT, ORE_ROUNDING_SETTLEMENT_MAX, roundOre } from '@/lib/money'
import { DEDUCTION_TYPE_LABELS } from '@/lib/bookkeeping/rot-rut-rules'
import { postingPort } from '@/lib/posting/port'
import { createLogger } from '@/lib/logger'
import { resolvePrimaryBankAccount } from './settlement-account'
import { findFiscalPeriod } from './engine'
import { installmentOutputVat } from './invoice-lines'
import {
  rotRutPayoutBusinessEvent,
  rotRutReclaimBusinessEvent,
  rotRutReclassificationBusinessEvent,
  type RotRutPostingContext,
} from './rot-rut-business-events'

/**
 * Settlement voucher for a rot/rut payout from Skatteverket.
 *
 * When the agency pays out a begäran, the 1513 receivable created at
 * invoicing (fakturamodellen) clears against the bank:
 *
 *   Debit  19xx bank account  [amount]
 *   Credit 1513 Skattereduktion rot/rut      [amount]
 *
 * One voucher per bank transfer: that mirrors the actual bank transaction.
 * Skatteverket decides per begäran but pays everything it decided that day
 * in ONE transfer, so a voucher may clear several begäran: one 1513 leg per
 * request (createRotRutPayoutSetEntry), the way match-batch books one bank
 * row against several customer invoices. The request side of the link is
 * rot_rut_payout_requests.settlement_journal_entry_id on every request the
 * voucher settles; source_id carries the first of them.
 *
 * A fully paid begäran also clears the öre its invoices carried on 1513 but
 * the whole-kronor BegartBelopp left out (oreRounding, lib/invoices/
 * rot-rut-receivable.ts): the leg credits 1513 with the full receivable and
 * 3740 Öresavrundning is debited the difference, so the bank leg stays the
 * paid amount:
 *
 *   Debit  19xx bank account                 [paid]
 *   Debit  3740 Öresavrundning               [oreRounding]
 *   Credit 1513 Skattereduktion rot/rut      [paid + oreRounding]
 *
 * At partial approval (delvis beviljad) the paid amount clears here and the
 * remainder stays on 1513 until the user corrects it (kundfordran/kundförlust
 * depending on the outcome with the buyer): deliberately manual, never
 * guessed.
 *
 * Kontantmetoden (bokslutsmetoden) books a ROT/RUT invoice in two steps
 * (ML 2023:200 7 kap. 16 §; Skatteverket, "Så fungerar rotavdraget"): the
 * customer's payment booked only the customer's share, so the payout is the
 * moment Skatteverket's share is received. For those invoices a leg's
 * `recognition` replaces the 1513 credit with the share's försäljning and
 * utgående moms, for what Skatteverket paid:
 *
 *   Debit  19xx bank account                 [paid]
 *   Credit 30xx Försäljning                  [paid, excl. moms]
 *   Credit 26xx Utgående moms                [moms in paid]
 *
 * Posting port (step 2f-2): the three generators here post through
 * lib/posting, which hands `input` to the engine unchanged and, while
 * POSTING_EVENTS is shadow or strict, records the business event first
 * (./rot-rut-business-events.ts) and has the engine link it to the draft
 * before a voucher number is drawn. Each takes `posting`, what the door saw
 * (its link basis, whether a bank line carried the payout), called only while
 * the port is on: off, the engine gets the call it always did.
 */
export interface RotRutPayoutLeg {
  requestId: string
  requestName: string
  deductionType: DeductionType
  /** What Skatteverket paid for this begäran (kr). */
  amount: number
  /**
   * The öre the invoices carry on 1513 beyond the paid kronor, under a krona
   * per invoice. Credited to 1513 on top of amount and debited to 3740. Omit
   * or 0 for none.
   */
  oreRounding?: number
  /** Invoices in the begäran: bounds oreRounding (< 1 kr each). Defaults to 1. */
  invoiceCount?: number
  /**
   * Kontantmetoden's second step (lib/invoices/rot-rut-payout-recognition.ts):
   * the part of `amount` paid on invoices whose deduction share was never put
   * on 1513, booked as that share's försäljning and utgående moms (`lines`,
   * credits adding up to `amount`) instead of a 1513 credit. Omit for none.
   */
  recognition?: { amount: number; lines: CreateJournalEntryLineInput[] }
}

/**
 * The deduction as named inside the voucher text: one kind reads as its own
 * (DEDUCTION_TYPE_LABELS.noun: 'ROT-avdrag', 'RUT-avdrag', 'skattereduktion
 * grön teknik'); ROT and RUT together keep 'ROT/RUT-avdrag'; any other mix
 * is the plain 'skattereduktion'.
 */
function deductionLabel(legs: Array<Pick<RotRutPayoutLeg, 'deductionType'>>): string {
  const types = new Set(legs.map((leg) => leg.deductionType))
  if (types.size === 1) {
    const [only] = [...types]
    return (DEDUCTION_TYPE_LABELS[only] ?? DEDUCTION_TYPE_LABELS.rot).noun
  }
  if ([...types].every((type) => type === 'rot' || type === 'rut')) return 'ROT/RUT-avdrag'
  return 'skattereduktion'
}

const log = createLogger('bookkeeping/rot-rut-entries')

function payoutDescription(label: string, names: string[]): string {
  return `Utbetalning ${label} från Skatteverket (${names.join(', ')})`
}

/**
 * The payout voucher's lines, pure: what createRotRutPayoutSetEntry books,
 * and what a set-off on the skattekonto books (the payout received there
 * instead of the bank, skattekonto-booking.ts: `bankAccount` is then the
 * skattekonto account). The first line is the money in. Throws on a leg the
 * voucher cannot carry (bad öre rounding, a recognition its lines do not
 * add up to).
 */
export function buildRotRutPayoutLines(params: {
  /** The account the payout landed on. */
  bankAccount: string
  /** One leg per begäran the transfer settles; at least one. */
  legs: RotRutPayoutLeg[]
}): { description: string; total: number; lines: CreateJournalEntryLineInput[]; recognisedVatSek: number } {
  if (params.legs.length === 0) {
    throw new Error('A rot/rut payout voucher needs at least one begäran')
  }
  const legs = params.legs.map((leg) => ({
    ...leg,
    amount: roundOre(leg.amount),
    oreRounding: roundOre(leg.oreRounding ?? 0),
  }))
  // Rounding is the truncation remainder: under a krona per invoice, so a leg
  // may reach a krona or more across several invoices (getRequestReceivable
  // enforces the per-invoice bound). Never negative, never more per leg than
  // the invoices it covers could leave.
  const badRounding = legs.find(
    (leg) =>
      leg.oreRounding < 0 ||
      leg.oreRounding >= ORE_ROUNDING_SETTLEMENT_MAX * Math.max(leg.invoiceCount ?? 1, 1),
  )
  if (badRounding) {
    throw new Error(`Invalid öre rounding ${badRounding.oreRounding} on begäran ${badRounding.requestName}`)
  }
  // A recognised part is never more than the leg, and its lines carry it
  // exactly: what is left of the leg (plus its öre) clears 1513.
  for (const leg of legs) {
    if (!leg.recognition) continue
    const recognised = roundOre(leg.recognition.amount)
    const linesTotal = roundOre(
      leg.recognition.lines.reduce((sum, line) => sum + line.credit_amount - line.debit_amount, 0),
    )
    if (recognised < 0 || recognised > leg.amount || linesTotal !== recognised) {
      throw new Error(`Invalid revenue recognition ${recognised} on begäran ${leg.requestName}`)
    }
  }
  const total = roundOre(legs.reduce((sum, leg) => sum + leg.amount, 0))
  const { bankAccount } = params
  const description = payoutDescription(
    deductionLabel(legs),
    legs.map((leg) => leg.requestName),
  )

  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: bankAccount,
      debit_amount: total,
      credit_amount: 0,
      line_description: description,
    },
    ...legs
      .filter((leg) => leg.oreRounding > 0)
      .map((leg) => ({
        account_number: ORE_ROUNDING_ACCOUNT,
        debit_amount: leg.oreRounding,
        credit_amount: 0,
        line_description: `Öresavrundning ${deductionLabel([leg])} (${leg.requestName})`,
      })),
    ...legs
      .map((leg) => ({
        account_number: '1513',
        debit_amount: 0,
        credit_amount: roundOre(leg.amount - roundOre(leg.recognition?.amount ?? 0) + leg.oreRounding),
        // A single begäran keeps the voucher text on both legs (as before);
        // a bundle names its own begäran on each 1513 leg.
        line_description:
          legs.length === 1
            ? description
            : payoutDescription(deductionLabel([leg]), [leg.requestName]),
      }))
      .filter((line) => line.credit_amount > 0),
    ...legs.flatMap((leg) => leg.recognition?.lines ?? []),
  ]
  const recognisedVatSek = installmentOutputVat(legs.flatMap((leg) => leg.recognition?.lines ?? []))
  return { description, total, lines, recognisedVatSek }
}

export async function createRotRutPayoutSetEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    paymentDate: string
    /** BAS 19xx account the payout landed on; the company's primary bank account when nothing names one. */
    bankAccount?: string
    /** One leg per begäran the transfer settles; at least one. */
    legs: RotRutPayoutLeg[]
  },
  posting?: () => RotRutPostingContext,
): Promise<JournalEntry> {
  if (params.legs.length === 0) {
    throw new Error('A rot/rut payout voucher needs at least one begäran')
  }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, params.paymentDate)
  if (!fiscalPeriodId) {
    throw new Error(`No open fiscal period found for payment date ${params.paymentDate}`)
  }

  const bankAccount = params.bankAccount ?? (await resolvePrimaryBankAccount(supabase, companyId, log))
  const { description, total, lines, recognisedVatSek } = buildRotRutPayoutLines({ ...params, bankAccount })
  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: params.paymentDate,
    description,
    source_type: 'rot_rut_payout',
    source_id: params.legs[0].requestId,
    lines,
  }

  return postingPort.postJournalEntry({
    supabase,
    companyId,
    userId,
    event: () =>
      rotRutPayoutBusinessEvent(
        { paymentDate: params.paymentDate, amount: total, recognisedVatSek },
        posting?.(),
      ),
    input,
  })
}

/** One begäran: the bundle voucher with a single 1513 leg. */
export async function createRotRutPayoutEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    requestId: string
    requestName: string
    deductionType: DeductionType
    paymentDate: string
    amount: number
    /** See RotRutPayoutLeg.oreRounding. */
    oreRounding?: number
    /** See RotRutPayoutLeg.invoiceCount. */
    invoiceCount?: number
    /** BAS 19xx account the payout landed on; the company's primary bank account when nothing names one. */
    bankAccount?: string
    /** See RotRutPayoutLeg.recognition. */
    recognition?: RotRutPayoutLeg['recognition']
  },
  posting?: () => RotRutPostingContext,
): Promise<JournalEntry> {
  return createRotRutPayoutSetEntry(
    supabase,
    companyId,
    userId,
    {
      paymentDate: params.paymentDate,
      bankAccount: params.bankAccount,
      legs: [
        {
          requestId: params.requestId,
          requestName: params.requestName,
          deductionType: params.deductionType,
          amount: params.amount,
          oreRounding: params.oreRounding,
          invoiceCount: params.invoiceCount,
          recognition: params.recognition,
        },
      ],
    },
    posting,
  )
}

/**
 * Reclaim voucher for the share of a begäran Skatteverket refused.
 *
 * The 1513 fordran booked at issue was never paid by Skatteverket, so it is
 * the buyer's again (HUSFL 2009:194; swedish-invoice-compliance section 8:
 * "SKV denies: Debit 1510, Credit 1513"):
 *
 *   Debit  1510 Kundfordringar               [refused share, per invoice]
 *   Credit 1513 Skattereduktion rot/rut      [refused share, per invoice]
 *
 * One voucher per begäran (source_id = request id, guarded by the partial
 * unique index journal_entries_rot_rut_reclaim_live_unique), one 1510 and one
 * 1513 leg per invoice so the kundreskontra can be read per faktura.
 */
export interface RotRutReclaimLeg {
  invoiceId: string
  invoiceNumber: string | null
  /** The refused share for this invoice (kr). */
  amount: number
}

export async function createRotRutReclaimEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    requestId: string
    requestName: string
    deductionType: DeductionType
    bookingDate: string
    /** One leg per invoice with a refused share; at least one, all > 0. */
    legs: RotRutReclaimLeg[]
  },
  posting?: () => RotRutPostingContext,
): Promise<JournalEntry> {
  const legs = params.legs
    .map((leg) => ({ ...leg, amount: roundOre(leg.amount) }))
    .filter((leg) => leg.amount > 0)
  if (legs.length === 0) {
    throw new Error('A rot/rut reclaim voucher needs at least one refused share')
  }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, params.bookingDate)
  if (!fiscalPeriodId) {
    throw new Error(`No open fiscal period found for booking date ${params.bookingDate}`)
  }

  // 'Nekat ROT-avdrag', 'Nekat RUT-avdrag' or 'Nekad skattereduktion grön teknik'.
  const refused = (DEDUCTION_TYPE_LABELS[params.deductionType] ?? DEDUCTION_TYPE_LABELS.rot).refused
  const description = `${refused} från Skatteverket (${params.requestName})`
  const legDescription = (leg: RotRutReclaimLeg) =>
    `${refused} faktura ${leg.invoiceNumber ?? leg.invoiceId}`

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: params.bookingDate,
    description,
    source_type: 'rot_rut_reclaim',
    source_id: params.requestId,
    lines: [
      ...legs.map((leg) => ({
        account_number: '1510',
        debit_amount: leg.amount,
        credit_amount: 0,
        line_description: legDescription(leg),
      })),
      ...legs.map((leg) => ({
        account_number: '1513',
        debit_amount: 0,
        credit_amount: leg.amount,
        line_description: legDescription(leg),
      })),
    ],
  }

  const refusedTotal = roundOre(legs.reduce((sum, leg) => sum + leg.amount, 0))
  return postingPort.postJournalEntry({
    supabase,
    companyId,
    userId,
    event: () => rotRutReclaimBusinessEvent({ bookingDate: params.bookingDate, amount: refusedTotal }, posting?.()),
    input,
  })
}

/**
 * Reclassification voucher for the household deduction of a migrated
 * invoice. Visma books the whole invoice on 1510; an invoice issued here
 * books the deduction on 1513 from day one (fakturamodellen,
 * swedish-invoice-compliance section 8). This moves it there:
 *
 *   Debit  1513 Skattereduktion rot/rut      [deduction]
 *   Credit 1510 Kundfordringar               [deduction]
 *
 * One voucher per invoice (source_id = invoice id, guarded by the partial
 * unique index journal_entries_rot_rut_reclassification_live_unique). Both
 * accounts carry SRU 7251, so no balance sheet, INK2 or VAT figure moves.
 */
export async function createMigratedDeductionEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    invoiceId: string
    invoiceNumber: string | null
    deductionType: DeductionType
    /** The deduction (kr), > 0. */
    amount: number
    bookingDate: string
  },
  posting?: () => RotRutPostingContext,
): Promise<JournalEntry> {
  const amount = roundOre(params.amount)
  if (!(amount > 0)) {
    throw new Error('A deduction reclassification voucher needs a positive amount')
  }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, params.bookingDate)
  if (!fiscalPeriodId) {
    throw new Error(`No open fiscal period found for booking date ${params.bookingDate}`)
  }

  // 'RUT-avdrag faktura 1042, omföring vid systembyte'.
  const ledger = (DEDUCTION_TYPE_LABELS[params.deductionType] ?? DEDUCTION_TYPE_LABELS.rot).ledger
  const description = `${ledger} faktura ${params.invoiceNumber ?? params.invoiceId}, omföring vid systembyte`

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: params.bookingDate,
    description,
    source_type: 'rot_rut_reclassification',
    source_id: params.invoiceId,
    lines: [
      { account_number: '1513', debit_amount: amount, credit_amount: 0, line_description: description },
      { account_number: '1510', debit_amount: 0, credit_amount: amount, line_description: description },
    ],
  }

  return postingPort.postJournalEntry({
    supabase,
    companyId,
    userId,
    event: () =>
      rotRutReclassificationBusinessEvent({ invoiceId: params.invoiceId, bookingDate: params.bookingDate, amount }, posting?.()),
    input,
  })
}
