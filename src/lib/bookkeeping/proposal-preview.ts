/**
 * The booking proposal preview: the lines a proposal posts, built by the code
 * that posts them.
 *
 * A bank row's proposal (the review's suggestion, a catalog template, a
 * learned counterparty template, an account the person picked) is the
 * categorize body the booking sends (categorizeBodyFor). The preview maps it
 * with buildCategorizeMapping and builds the lines with
 * buildTransactionEntryLines: the two steps categorizeTransaction posts with,
 * so the review shows the verifikat the booking makes, to the öre.
 *
 * A template applied to a typed total (Ny verifikation, Bokför från mall, an
 * utlägg's omvänd skattskyldighet) is booked like a bank row of that total:
 * the template builder, the reverse-charge basis settled with the company's
 * momskoder, the same line assembly.
 *
 * Nothing here writes. The row's own guards (already booked, possible
 * duplicate, period lock, inactive accounts, an open invoice the payment
 * belongs to) are the booking's to answer; the preview shows the kontering.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildCategorizeMapping,
  linesNotBalancedRefusal,
  resolveCategorizeContext,
  type CategorizeInput,
  type CategorizeRefusal,
} from '@/lib/transactions/categorize-core'
import { buildMappingResultFromTemplate, type BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { reconcileRcBasisWithChart } from '@/lib/bookkeeping/rc-basis-reconcile'
import { resolveSkattekontoAccount, templateTouchesSkattekonto } from '@/lib/skatteverket/skattekonto-account'
import { chartVatTreatmentsLoader } from '@/lib/bookkeeping/chart-vat-treatments'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { TransactionLinesNotBalancedError, TransactionMissingSekValueError } from '@/lib/bookkeeping/errors'
import { getVatRate } from '@/lib/bookkeeping/vat-entries'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { Logger } from '@/lib/logger'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import type { CreateJournalEntryLineInput, Transaction, VatTreatment } from '@/types'

/** One debit/credit pair booked as money out: an utlägg's cost against its liability. */
export interface ProposalPreviewPair {
  debit_account: string
  credit_account: string
  vat_treatment: VatTreatment | null
  reverse_charge_supplier_type?: BookingTemplate['reverse_charge_supplier_type']
}

export type ProposalPreviewRequest =
  | { transaction_id: string; booking: CategorizeInput }
  | { amount: number; template_id: string }
  | { amount: number; pair: ProposalPreviewPair }

export type ProposalPreviewOutcome = { ok: true; lines: ProposalLine[] } | CategorizeRefusal

interface PreviewContext {
  supabase: SupabaseClient
  companyId: string
  log: Logger
}

/**
 * The verifikat lines as the review shows them. The money leg is the last
 * line on money out and the first on money in: buildTransactionEntryLines
 * places it there on every branch (single pair, VAT, private, line pattern).
 */
export function toProposalLines(transaction: Pick<Transaction, 'amount'>, lines: CreateJournalEntryLineInput[]): ProposalLine[] {
  const settlementIndex = transaction.amount < 0 ? lines.length - 1 : 0
  return lines.map((line, i) => ({
    side: line.debit_amount > 0 ? 'debet' : 'kredit',
    account: line.account_number,
    amount: line.debit_amount > 0 ? line.debit_amount : line.credit_amount,
    ...(i === settlementIndex ? { settlement: true } : {}),
  }))
}

function missingSek(err: TransactionMissingSekValueError): CategorizeRefusal {
  return { ok: false, code: err.code, details: { currency: err.currency, transaction_date: err.date }, cause: err }
}

/** The proposal's lines, or the refusal the booking would answer it with. */
export async function previewProposalLines(
  ctx: PreviewContext,
  request: ProposalPreviewRequest,
): Promise<ProposalPreviewOutcome> {
  return 'transaction_id' in request ? previewForTransaction(ctx, request) : previewForTotal(ctx, request)
}

async function previewForTransaction(
  { supabase, companyId, log }: PreviewContext,
  { transaction_id, booking }: { transaction_id: string; booking: CategorizeInput },
): Promise<ProposalPreviewOutcome> {
  const { data: row, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transaction_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`proposal preview: transaction read failed: ${error.message}`)
  if (!row) return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }
  const transaction = row as Transaction

  const resolved = await resolveCategorizeContext(supabase, companyId, booking)
  if (!resolved.ok) return resolved
  const mapped = await buildCategorizeMapping(supabase, companyId, transaction, booking, resolved.context, {
    log,
    preview: true,
  })
  if (!mapped.ok) return mapped

  try {
    return { ok: true, lines: toProposalLines(transaction, buildTransactionEntryLines(transaction, mapped.mappingResult)) }
  } catch (err) {
    if (err instanceof TransactionMissingSekValueError) return missingSek(err)
    // The review shows the refusal the booking would answer, not lines that
    // cannot post.
    if (err instanceof TransactionLinesNotBalancedError) return linesNotBalancedRefusal(err, transaction, booking)
    throw err
  }
}

/**
 * A template of one pair, for the template builder: a cost against its
 * liability with the pair's moms, the rest at the catalog's neutral values.
 */
function pairTemplate(pair: ProposalPreviewPair): BookingTemplate {
  return {
    id: 'proposal-preview-pair',
    name_sv: '',
    name_en: '',
    group: 'professional_services',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: pair.debit_account,
    credit_account: pair.credit_account,
    vat_treatment: pair.vat_treatment,
    vat_rate: pair.vat_treatment ? getVatRate(pair.vat_treatment) : 0,
    deductibility: 'full',
    mcc_codes: [],
    keywords: [],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 0,
    auto_match_confidence: 0,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: '',
    common: false,
    reverse_charge_supplier_type: pair.reverse_charge_supplier_type,
  }
}

async function previewForTotal(
  { supabase, companyId }: PreviewContext,
  request: { amount: number; template_id: string } | { amount: number; pair: ProposalPreviewPair },
): Promise<ProposalPreviewOutcome> {
  const resolved = await resolveCategorizeContext(supabase, companyId, {
    is_business: true,
    ...('template_id' in request ? { template_id: request.template_id } : {}),
  })
  if (!resolved.ok) return resolved
  const { context } = resolved
  const template = 'pair' in request ? pairTemplate(request.pair) : context.template
  if (!template) return { ok: false, code: 'TX_CATEGORIZE_INVALID_TEMPLATE', details: { reason: 'unknown_template' } }

  // The total booked as the bank row it would be: money in for an income
  // template, money out for an expense or a transfer (whose two legs then
  // book as the template writes them).
  const abs = Math.abs(request.amount)
  const amount = template.direction === 'income' ? abs : -abs
  const transaction = {
    id: 'proposal-preview',
    company_id: companyId,
    date: todayIsoStockholm(),
    amount,
    currency: 'SEK',
    amount_sek: amount,
    exchange_rate: null,
    description: '',
    cash_account_id: null,
  } as unknown as Transaction

  // A template that names the skattekonto (1630) books the company's
  // skattekonto account, as buildCategorizeMapping does: 2012 for an enskild
  // firma that runs it there (PH 175).
  const skattekontoAccount = templateTouchesSkattekonto([
    template.debit_account,
    template.credit_account,
    template.debit_account_ab,
    template.credit_account_ab,
  ])
    ? await resolveSkattekontoAccount(supabase, companyId)
    : undefined
  const mapping = await reconcileRcBasisWithChart(
    buildMappingResultFromTemplate(template, transaction, context.entityType, context.vatRegistered, skattekontoAccount),
    chartVatTreatmentsLoader(supabase, companyId),
  )
  return { ok: true, lines: toProposalLines(transaction, buildTransactionEntryLines(transaction, mapping)) }
}
