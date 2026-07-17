import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import {
  calculateBolagsskatt,
  sumPostedYearEndDispositions,
} from '@/lib/bokslut/tax-provision/bolagsskatt-calculator'
import { calculateSarskildLoneskatt } from '@/lib/bokslut/tax-provision/sarskild-loneskatt-calculator'
import {
  getPeriodiseringsfondCohortAccount,
  getSchablonintaktRate,
  listExistingPeriodiseringsfonder,
  proposeAvsattning,
  proposeAteforing,
} from '@/lib/bokslut/reserves/periodiseringsfond-service'
import { proposeOveravskrivningar } from '@/lib/bokslut/reserves/overavskrivningar-service'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import {
  buildDispositionsProposal,
  buildLatentTaxProposal,
} from '@/lib/bokslut/dispositions-proposal-builder'
import type { ProposedDisposition } from '@/lib/bokslut/types'
import type { JournalEntry } from '@/types'

/**
 * The schablonintäkt rate (IL 30 kap 6a §) defaults per fiscal year via
 * getSchablonintaktRate (statslåneräntan 30 nov året före det kalenderår
 * beskattningsåret går ut, lägst 0.5 %). Caller can override per request
 * via `schablonintaktRate` in the POST body; a future Riksbanken
 * integration will fetch the rate automatically.
 *
 * Canonical bokslut order. Each calculator re-reads the trial balance to
 * derive its base, so earlier items must post before later items see their
 * effect: återföring → överavskrivningar → SLP → avsättning → bolagsskatt.
 * SLP posts before avsättning because it is deductible: the 25 % avsättning
 * cap applies to the result AFTER the SLP cost (IL 30 kap 5 §). The POST
 * handler enforces this order regardless of how the client sends its items
 * array, so the avsättning cap can never be evaluated against a stale
 * (pre-återföring, pre-SLP) net result.
 */
const DISPOSITION_ORDER: Record<string, number> = {
  periodiseringsfond_ateforing: 0,
  overavskrivningar: 1,
  sarskild_loneskatt: 2,
  periodiseringsfond_avsattning: 3,
  bolagsskatt: 4,
  // K3 only: posts last because it depends on the closing 21xx balance,
  // which only stabilises once avsättning / återföring have been applied.
  uppskjuten_skatt: 5,
}

// ============================================================
// GET: return proposal snapshot with defaults
// ============================================================
export const GET = withRouteContext(
  'period.bokslutsdispositioner_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const data = await buildDispositionsProposal(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('bokslutsdispositioner preview failed', err as Error)
      return errorResponse(err, opLog, { requestId })
    }
  },
)

// ============================================================
// POST: commit a list of dispositions chosen by the user
// ============================================================
const ItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bolagsskatt'),
    manualAdjustments: z
      .object({
        nonDeductibleExpenses: z.number().optional(),
        nonTaxableIncome: z.number().optional(),
        schablonintaktPeriodiseringsfond: z.number().optional(),
        other: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('sarskild_loneskatt'),
    manualAdjustment: z.number().optional(),
  }),
  z.object({
    kind: z.literal('periodiseringsfond_avsattning'),
    /** Optional override for the SLR-based schablonintäkt rate; defaults to
     *  the server-side constant. Used both to compute the cap base and to
     *  feed back into bolagsskatt's adjustment if present in the same batch.
     *  Bounded to a sane range — an inflated rate would inflate the cap base
     *  and let the caller exceed the legal 25 % avsättning limit (IL 30 kap). */
    schablonintaktRate: z.number().min(0).max(0.2).optional(),
    desiredAmount: z.number().positive().optional(),
  }),
  z.object({
    kind: z.literal('periodiseringsfond_ateforing'),
    returns: z.record(z.string(), z.number().nonnegative()).default({}),
    schablonintaktRate: z.number().min(0).max(0.2).optional(),
  }),
  z.object({
    kind: z.literal('overavskrivningar'),
    additionalAmount: z.number(),
    /** Asset category for BAS account selection: defaults to maskiner &
     *  inventarier (8853/2153), the dominant K2 case. */
    category: z
      .enum(['machinery_equipment', 'building', 'immaterial', 'group'])
      .optional(),
  }),
  // K3 only: uppskjuten skatt provision. Server recomputes the amount from
  // current 2240 + 21xx state so the client cannot override it.
  z.object({
    kind: z.literal('uppskjuten_skatt'),
  }),
])

const PostBodySchema = z.object({
  items: z.array(ItemSchema).min(1),
})

export const POST = withRouteContext(
  'period.bokslutsdispositioner_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    const validation = await validateBody(request, PostBodySchema)
    if (!validation.success) return validation.response

    try {
      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, opening_balance_entry_id, is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()
      if (periodError || !period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      if (period.is_closed || period.closing_entry_id || period.locked_at) {
        return errorResponseFromCode('PERIOD_LOCKED', opLog, { requestId })
      }

      const fiscalYear = parseInt(period.period_end.slice(0, 4), 10)
      const created: { kind: string; entry: JournalEntry }[] = []

      // Process items in canonical bokslut order regardless of client array
      // ordering: each computation pulls the current income statement, so
      // återföring must post before avsättning sees its cap base; över-
      // avskrivningar must post before bolagsskatt; SLP and bolagsskatt last.
      const sortedItems = [...validation.data.items].sort(
        (a, b) => DISPOSITION_ORDER[a.kind] - DISPOSITION_ORDER[b.kind],
      )

      // KNOWN LIMITATION (SOC 2 PI1.3): the loop is not wrapped in a database
      // transaction: each item posts its own journal entry via the engine.
      // A failure midway leaves earlier items committed and later ones not.
      // Recovery: the UI can re-POST omitting already-committed kinds; each
      // calculator re-derives from the current trial balance so the next run
      // produces correct amounts on top of what's already there. A future
      // RPC-level wrapper (Phase 5+) will make this atomic.
      for (const item of sortedItems) {
        const proposal = await computeProposal(item, supabase, companyId, period, fiscalYear)
        if (!proposal) continue

        const entry = await createJournalEntry(supabase, companyId, user.id, {
          fiscal_period_id: id,
          entry_date: period.period_end,
          description: `Bokslutsdisposition: ${proposal.label}`,
          source_type: 'year_end',
          voucher_series: 'A',
          lines: proposal.lines,
        })
        created.push({ kind: item.kind, entry })
      }

      return NextResponse.json({ data: { created } })
    } catch (err) {
      opLog.error('bokslutsdispositioner post failed', err as Error)
      return errorResponse(err, opLog, { requestId })
    }
  },
  { requireWrite: true },
)

type PostItem = z.infer<typeof ItemSchema>

/** The period row the POST handler already validated. Passed through so the
 *  per-item computations never re-fetch it: a transient DB failure on a
 *  re-fetch must fail the request, not silently skip a disposition. */
interface ValidatedPeriod {
  id: string
  period_start: string
  period_end: string
  opening_balance_entry_id: string | null
}

async function computeProposal(
  item: PostItem,
  supabase: Parameters<typeof calculateBolagsskatt>[0],
  companyId: string,
  period: ValidatedPeriod,
  fiscalYear: number,
): Promise<ProposedDisposition | null> {
  const fiscalPeriodId = period.id
  switch (item.kind) {
    case 'bolagsskatt': {
      // Dispositioner are booked as source_type='year_end', which the income
      // statement excludes, so net_result alone overstates resultat före skatt.
      // Add the already-posted dispositions back (avsättning −, återföring +,
      // SLP −, överavskrivningar −); bolagsskatt is sorted LAST so they are
      // committed by now. Without this the booked tax ignores the avsättning
      // (the original customer bug, too-high tax, ÅR/INK2 mismatch).
      const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
      const dispositionsEffect = await sumPostedYearEndDispositions(
        supabase,
        companyId,
        fiscalPeriodId,
      )
      return calculateBolagsskatt(supabase, companyId, fiscalPeriodId, {
        resultBeforeTaxOverride: incomeStatement.net_result + dispositionsEffect.total,
        manualAdjustments: item.manualAdjustments,
      })
    }
    case 'sarskild_loneskatt': {
      // Already posted in this period (resumed run / duplicate POST): the
      // calculator is not posted-aware and would book the full SLP again.
      const posted = await sumPostedYearEndDispositions(supabase, companyId, fiscalPeriodId)
      if (posted.slpPortion !== 0) return null
      return calculateSarskildLoneskatt(supabase, companyId, fiscalPeriodId, {
        manualAdjustment: item.manualAdjustment,
      })
    }
    case 'periodiseringsfond_avsattning': {
      // Re-derive the cap base from current state so the user can't sneak in
      // a higher desiredAmount than 25 % of actual skattemässigt resultat.
      const incomeStatement = await generateIncomeStatement(
        supabase,
        companyId,
        fiscalPeriodId,
      )
      const existing = await listExistingPeriodiseringsfonder(
        supabase,
        companyId,
        period.period_end,
        period.period_start,
        period.opening_balance_entry_id,
      )
      const schablonintaktRate = item.schablonintaktRate ?? getSchablonintaktRate(fiscalYear)
      // Schablonintäkt applies to the fond balance at the START of the tax
      // year (IL 30 kap 6a §): opening balances, regardless of what has
      // been avsatt or återfört during the period.
      const schablonintakt = existing.reduce(
        (sum, f) => sum + Math.max(0, f.opening_balance) * schablonintaktRate,
        0,
      )
      // A previous avsättning in this bokslut consumes 25 %-cap headroom:
      // without this, re-running the flow books the fond twice. Measured as
      // the current cohort ACCOUNT's growth during the period so a
      // prior-year fond sharing the account (shortened brutet räkenskapsår,
      // decade wrap) does not consume this year's headroom.
      const currentCohort = existing.find(
        (f) => f.account_number === getPeriodiseringsfondCohortAccount(fiscalYear),
      )
      const alreadyProvisioned = currentCohort
        ? Math.max(0, currentCohort.balance - Math.max(0, currentCohort.opening_balance))
        : 0
      // Dispositions posted earlier in this batch (återföring, över-
      // avskrivningar, SLP: all sorted before avsättning) are year_end-typed
      // and thus invisible in net_result, yet they move the cap base. Add
      // their signed effect back, then add back any posted avsättning itself
      // (the cap applies to the result BEFORE avsättning; headroom is
      // handled via alreadyProvisioned).
      const postedEffect = await sumPostedYearEndDispositions(
        supabase,
        companyId,
        fiscalPeriodId,
      )
      const base =
        incomeStatement.net_result + postedEffect.total + alreadyProvisioned
        + Math.round(schablonintakt)
      return proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: base,
        desiredAmount: item.desiredAmount,
        fiscalYear,
        alreadyProvisioned,
      })
    }
    case 'periodiseringsfond_ateforing': {
      // Recompute existing fonder server-side so the user can't return more
      // than is on the books.
      const existing = await listExistingPeriodiseringsfonder(
        supabase,
        companyId,
        period.period_end,
        period.period_start,
        period.opening_balance_entry_id,
      )
      const result = proposeAteforing(existing, {
        returns: item.returns,
        schablonintaktRate: item.schablonintaktRate ?? getSchablonintaktRate(fiscalYear),
      })
      // Combine multiple cohort reversals into a single voucher with multiple
      // lines so we don't blow up voucher numbering, but each fond is its own
      // line pair already. Build a merged ProposedDisposition.
      if (result.proposals.length === 0) return null
      return mergeAteforingProposals(result.proposals)
    }
    case 'overavskrivningar':
      return proposeOveravskrivningar({
        additionalAmount: item.additionalAmount,
        category: item.category,
      })
    case 'uppskjuten_skatt':
      // Server-only: recompute from current TB (which already reflects any
      // 21xx postings that committed earlier in this batch). The client
      // sends no amount: the calculator owns the K3 split.
      return buildLatentTaxProposal({
        supabase,
        companyId,
        fiscalPeriodId,
      })
  }
}

function mergeAteforingProposals(proposals: ProposedDisposition[]): ProposedDisposition {
  const lines = proposals.flatMap((p) => p.lines)
  const totalAmount = proposals.reduce((sum, p) => sum + p.amount, 0)
  const warnings = proposals.flatMap((p) => p.warnings)
  return {
    kind: 'periodiseringsfond_ateforing',
    label: 'Återföring periodiseringsfond',
    description: proposals.map((p) => p.label).join(', '),
    amount: totalAmount,
    lines,
    warnings,
  }
}
