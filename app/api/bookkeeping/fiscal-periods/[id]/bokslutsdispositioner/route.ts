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
 * Default schablonintäkt rate on periodiseringsfond (IL 30 kap 6a §).
 * Statslåneräntan 30 november föregående år + 1 procentenhet, lägst 0.5 %.
 *
 *   - inkomstår 2025: SLR 2024-11-30 = 1.96 % → 2.96 % (rounded to 3 %)
 *   - inkomstår 2026: SLR 2025-11-30 = 2.55 % → 3.55 %
 *
 * The default below is the FY2026 rate since that is the year customers are
 * currently closing. Caller can override per request via `schablonintaktRate`
 * in the POST body; a future Riksbanken integration will fetch the rate by
 * the fiscal year automatically.
 */
const DEFAULT_SCHABLONINTAKT_RATE = 0.0355

/**
 * Canonical bokslut order. Each calculator re-reads the trial balance to
 * derive its base, so earlier items must post before later items see their
 * effect: återföring → överavskrivningar → avsättning → SLP → bolagsskatt.
 * The POST handler enforces this order regardless of how the client sends
 * its items array, so the avsättning 25 % cap can never be evaluated
 * against a stale (pre-återföring) net result.
 */
const DISPOSITION_ORDER: Record<string, number> = {
  periodiseringsfond_ateforing: 0,
  overavskrivningar: 1,
  periodiseringsfond_avsattning: 2,
  sarskild_loneskatt: 3,
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
     *  feed back into bolagsskatt's adjustment if present in the same batch. */
    schablonintaktRate: z.number().optional(),
    desiredAmount: z.number().optional(),
  }),
  z.object({
    kind: z.literal('periodiseringsfond_ateforing'),
    returns: z.record(z.string(), z.number()).default({}),
    schablonintaktRate: z.number().default(DEFAULT_SCHABLONINTAKT_RATE),
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
        .select('id, name, period_end, is_closed, locked_at, closing_entry_id')
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
        const proposal = await computeProposal(item, supabase, companyId, id, fiscalYear)
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

async function computeProposal(
  item: PostItem,
  supabase: Parameters<typeof calculateBolagsskatt>[0],
  companyId: string,
  fiscalPeriodId: string,
  fiscalYear: number,
): Promise<ProposedDisposition | null> {
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
        resultBeforeTaxOverride: incomeStatement.net_result + dispositionsEffect,
        manualAdjustments: item.manualAdjustments,
      })
    }
    case 'sarskild_loneskatt':
      return calculateSarskildLoneskatt(supabase, companyId, fiscalPeriodId, {
        manualAdjustment: item.manualAdjustment,
      })
    case 'periodiseringsfond_avsattning': {
      // Re-derive the cap base from current state so the user can't sneak in
      // a higher desiredAmount than 25 % of actual skattemässigt resultat.
      const incomeStatement = await generateIncomeStatement(
        supabase,
        companyId,
        fiscalPeriodId,
      )
      const { data: periodRow } = await supabase
        .from('fiscal_periods')
        .select('period_end')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()
      const periodEnd = periodRow?.period_end ?? `${fiscalYear}-12-31`
      const existing = await listExistingPeriodiseringsfonder(supabase, companyId, periodEnd)
      const schablonintaktRate = item.schablonintaktRate ?? DEFAULT_SCHABLONINTAKT_RATE
      const schablonintakt = existing.reduce(
        (sum, f) => sum + f.balance * schablonintaktRate,
        0,
      )
      const base = incomeStatement.net_result + Math.round(schablonintakt)
      return proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: base,
        desiredAmount: item.desiredAmount,
        fiscalYear,
      })
    }
    case 'periodiseringsfond_ateforing': {
      // Recompute existing fonder server-side so the user can't return more
      // than is on the books.
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('period_end')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()
      if (!period) return null
      const existing = await listExistingPeriodiseringsfonder(
        supabase,
        companyId,
        period.period_end,
      )
      const result = proposeAteforing(existing, {
        returns: item.returns,
        schablonintaktRate: item.schablonintaktRate,
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
