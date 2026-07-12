import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import {
  buildAccrualsProposal,
  proposeAccruedInterest,
  proposeAccruedUtility,
  proposeAuditFee,
  proposeManualAccrued,
  proposeManualPrepaid,
  proposeRevenueDeferral,
  proposeVacationLiabilityChange,
} from '@/lib/bokslut/accruals/accrual-detector'
import { detectPeriodisering } from '@/lib/bokslut/accruals/auto-detect'
import type { AccrualProposal } from '@/lib/bokslut/accruals/types'
import type { JournalEntry } from '@/types'

export const GET = withRouteContext(
  'period.accruals_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      // Run the two independent scans in parallel so the wizard's first
      // paint isn't gated on the slower auto-detect query.
      const [proposal, autoDetected] = await Promise.all([
        buildAccrualsProposal(supabase, companyId, id),
        detectPeriodisering(supabase, companyId, id).catch((err) => {
          // Auto-detect is best-effort: a malformed invoice description
          // shouldn't break the rest of the preflight. Log + return empty.
          log.warn('auto-detect failed', { error: (err as Error)?.message })
          return []
        }),
      ])
      return NextResponse.json({ data: { ...proposal, autoDetected } })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
)

// Defense-in-depth on caller-supplied account numbers. The wizard sends
// accounts from a closed template list, but the API accepts them as plain
// strings so we constrain the BAS class per accrual kind:
//   - cost accounts (5xxx-8xxx) for expense legs
//   - revenue accounts (3xxx) for revenue legs
//   - 17xx for förutbetalda kostnader (prepaid)
//   - 29xx for upplupna poster (accrued / deferred)
// Anything outside these ranges is rejected with 400 before reaching the
// engine: keeps a compromised browser session from posting arbitrary
// balance-sheet hits.
const EXPENSE_ACCOUNT_RE = /^[5-8]\d{3}$/
const REVENUE_ACCOUNT_RE = /^3\d{3}$/

const PostItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vacation_liability_change') }),
  z.object({
    kind: z.literal('audit_fee'),
    amount: z.number().positive(),
    liability_account: z.enum(['2991', '2992']).optional(),
  }),
  z.object({
    kind: z.literal('manual_prepaid_expense'),
    amount: z.number().positive(),
    expense_account: z.string().regex(EXPENSE_ACCOUNT_RE),
    prepaid_account: z.string().regex(/^17\d{2}$/),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal('manual_accrued_expense'),
    amount: z.number().positive(),
    expense_account: z.string().regex(EXPENSE_ACCOUNT_RE),
    accrued_account: z.string().regex(/^29\d{2}$/),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal('deferred_revenue'),
    amount: z.number().positive(),
    revenue_account: z.string().regex(REVENUE_ACCOUNT_RE),
    deferred_account: z.string().regex(/^29\d{2}$/),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal('accrued_interest'),
    amount: z.number().positive(),
    expense_account: z.string().regex(EXPENSE_ACCOUNT_RE),
    accrued_account: z.string().regex(/^29\d{2}$/),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal('accrued_utility'),
    amount: z.number().positive(),
    expense_account: z.string().regex(EXPENSE_ACCOUNT_RE),
    accrued_account: z.string().regex(/^29\d{2}$/),
    description: z.string().min(1),
  }),
])

const PostBodySchema = z.object({
  items: z.array(PostItemSchema).min(1),
})

export const POST = withRouteContext(
  'period.accruals_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, PostBodySchema)
    if (!validation.success) return validation.response

    try {
      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_end, is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()
      if (periodError || !period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (period.is_closed || period.closing_entry_id || period.locked_at) {
        return errorResponseFromCode('PERIOD_LOCKED', log, { requestId })
      }

      const created: { kind: string; entry: JournalEntry; reverses_on: string | null }[] = []
      const skipped: { kind: string; existing_entry_id: string; reason: string }[] = []

      for (const item of validation.data.items) {
        // Idempotency: refuse to post a duplicate accrual of the same kind for
        // the same period. Without this, re-running the wizard (or a retried
        // request after a flaky network) would create duplicate entries that
        // distort both the balance sheet and the trial balance.
        const existingId = await findExistingAccrualEntry(supabase, companyId, id, item)
        if (existingId) {
          skipped.push({
            kind: item.kind,
            existing_entry_id: existingId,
            reason: 'already_posted',
          })
          continue
        }

        let proposal: AccrualProposal | null = null
        switch (item.kind) {
          case 'vacation_liability_change':
            proposal = await proposeVacationLiabilityChange(supabase, companyId, id, {
              closingDate: period.period_end,
            })
            break
          case 'audit_fee':
            proposal = proposeAuditFee({
              amount: item.amount,
              closingDate: period.period_end,
              liabilityAccount: item.liability_account,
            })
            break
          case 'manual_prepaid_expense':
            proposal = proposeManualPrepaid({
              amount: item.amount,
              expenseAccount: item.expense_account,
              prepaidAccount: item.prepaid_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
          case 'manual_accrued_expense':
            proposal = proposeManualAccrued({
              amount: item.amount,
              expenseAccount: item.expense_account,
              accruedAccount: item.accrued_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
          case 'deferred_revenue':
            proposal = proposeRevenueDeferral({
              amount: item.amount,
              revenueAccount: item.revenue_account,
              deferredAccount: item.deferred_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
          case 'accrued_interest':
            proposal = proposeAccruedInterest({
              amount: item.amount,
              expenseAccount: item.expense_account,
              accruedAccount: item.accrued_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
          case 'accrued_utility':
            proposal = proposeAccruedUtility({
              amount: item.amount,
              expenseAccount: item.expense_account,
              accruedAccount: item.accrued_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
        }
        if (!proposal) continue

        // Mark the entry's description with the reversal date so future
        // bookkeepers (and a future cron) can spot the periodisering. The
        // accrual_reversals cron is follow-up infra: once it lands, the
        // entry's source_type or a metadata column can drive the auto-flip.
        //
        // Vacation-liability adjustments deliberately have empty reverses_on
        // since 2920 carries forward: emit a different description in that
        // case so future readers don't expect a Jan 1 reversal.
        const description = proposal.reverses_on
          ? `Periodisering: ${proposal.label} (vänds ${proposal.reverses_on})`
          : `Bokslutsjustering: ${proposal.label}`
        const entry = await createJournalEntry(supabase, companyId, user.id, {
          fiscal_period_id: id,
          entry_date: period.period_end,
          description,
          source_type: 'manual',
          voucher_series: 'A',
          lines: proposal.lines,
        })

        created.push({ kind: item.kind, entry, reverses_on: proposal.reverses_on })
      }

      return NextResponse.json({ data: { created, skipped } })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)

type PostItem = z.infer<typeof PostItemSchema>

/**
 * Find a previously-posted accrual journal entry for the same kind in the
 * same period, used by the POST handler to enforce idempotency. Matches
 * on the description prefix that each calculator emits (see
 * accrual-detector.ts and the POST handler's description construction).
 *
 * For manual prepaid/accrued the dedup key includes the user-supplied
 * description, so different items with different descriptions don't collide.
 */
async function findExistingAccrualEntry(
  supabase: Awaited<ReturnType<typeof import('@/lib/supabase/server')['createClient']>>,
  companyId: string,
  fiscalPeriodId: string,
  item: PostItem,
): Promise<string | null> {
  let pattern: string
  switch (item.kind) {
    case 'vacation_liability_change':
      pattern = '%semesterlöneskuld%'
      break
    case 'audit_fee': {
      const account = item.liability_account ?? '2992'
      pattern = account === '2991' ? '%arvode för bokslut%' : '%arvode för revision%'
      break
    }
    case 'manual_prepaid_expense':
      pattern = `Periodisering: Förutbetald kostnad: ${escapeLike(item.description)}%`
      break
    case 'manual_accrued_expense':
      pattern = `Periodisering: Upplupen kostnad: ${escapeLike(item.description)}%`
      break
    case 'deferred_revenue':
      pattern = `Periodisering: Förutbetald intäkt: ${escapeLike(item.description)}%`
      break
    case 'accrued_interest':
      pattern = `Periodisering: Upplupen ränta: ${escapeLike(item.description)}%`
      break
    case 'accrued_utility':
      pattern = `Periodisering: Upplupen förbrukning: ${escapeLike(item.description)}%`
      break
  }

  const { data } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'posted')
    .ilike('description', pattern)
    .limit(1)
  return (data?.[0]?.id as string | undefined) ?? null
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}
