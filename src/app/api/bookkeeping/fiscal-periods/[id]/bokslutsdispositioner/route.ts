import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode, isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { resolveCompanyEntityType, supportsCorporateTaxDispositions } from '@/lib/company/entity-type'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { yearEndDispositionBusinessEvent } from '@/lib/bokslut/dispositions-business-event'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { saveTaxAdjustments } from '@/lib/bokslut/tax-provision/tax-adjustment-service'
import { calculateSarskildLoneskatt } from '@/lib/bokslut/tax-provision/sarskild-loneskatt-calculator'
import { proposeOveravskrivningar } from '@/lib/bokslut/reserves/overavskrivningar-service'
import { calculateOveravskrivningar } from '@/lib/bokslut/reserves/overavskrivningar-calculator'
import { roundOre } from '@/lib/money'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import {
  ateforingDispositions,
  avsattningDisposition,
  bolagsskattDisposition,
  fondUppraekning,
  buildDispositionsProposal,
  loadDispositionState,
} from '@/lib/bokslut/dispositions-proposal-builder'
import type { ProposedDisposition } from '@/lib/bokslut/types'
import { closingDeficitOf, postDeferredTax } from '@/lib/bokslut/tax-provision/deferred-tax-service'
import { buildDevelopmentFundProposal } from '@/lib/bokslut/development-fund'
import type { JournalEntry } from '@/types'

/**
 * The schablonintäkt rate (IL 30 kap 6a §) defaults per fiscal year via
 * resolveSchablonintaktRate (statslåneräntan 30 nov året före det kalenderår
 * beskattningsåret går ut, lägst 0.5 %; only consulted when the company holds
 * fonder at the start of the year). Caller can override per request via
 * `schablonintaktRate` in the POST body; a future Riksbanken integration
 * will fetch the rate automatically.
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
  // After bolagsskatt: the loss carried forward it may recognise is the
  // bolagsskatt computation's closing underskott (K3 years only).
  uppskjuten_skatt_kap29: 5,
  // An equity transfer (ÅRL 4 kap. 2 §): no effect on the items above.
  fond_for_utvecklingsutgifter: 6,
}

/**
 * Legal-form gate for every write on this route. The year-end wizard shows
 * no dispositions to a form whose profile lacks them, but a hand-made
 * request with {items:[{kind:'bolagsskatt'}]} would still compute and POST
 * corporate tax on an enskild firma or an ideell förening (only
 * överavskrivningar gated itself). Every kind is refused together, including
 * sarskild_loneskatt: whether SLP applies to a förening employer is a domain
 * question we have not settled, so it is gated with the rest for now. The
 * form comes from companies.entity_type, never a default.
 */
async function dispositionsGate(
  supabase: Parameters<typeof resolveCompanyEntityType>[0],
  companyId: string,
  opLog: Parameters<typeof errorResponseFromCode>[1],
  requestId: string | undefined,
): Promise<NextResponse | null> {
  const form = await resolveCompanyEntityType(supabase, companyId)
  if (supportsCorporateTaxDispositions(form)) return null
  return errorResponseFromCode('YEAR_END_DISPOSITIONS_WRONG_LEGAL_FORM', opLog, {
    requestId,
    details: { entity_type: form },
  })
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

const PutBodySchema = z.object({
  manualAdjustments: z.object({
    nonDeductibleExpenses: z.number().nonnegative().max(1_000_000_000_000),
    nonTaxableIncome: z.number().nonnegative().max(1_000_000_000_000),
    // INK2S 4.14 a. Defaulted so a client that predates the field keeps
    // saving the other two without clearing anything.
    deficitCarryforward: z.number().nonnegative().max(1_000_000_000_000).default(0),
  }),
  // Keyed by account number: the detected list depends on the legal form
  // (tax-adjustment-service), so the shape is open and the service ignores
  // accounts it does not detect for this company.
  detectedAccounts: z.record(z.string().regex(ACCOUNT_NUMBER_RE), z.boolean()),
})

export const PUT = withRouteContext(
  'period.bokslutsdispositioner_adjustments',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })
    const validation = await validateBody(request, PutBodySchema)
    if (!validation.success) return validation.response

    try {
      const refused = await dispositionsGate(supabase, companyId, opLog, requestId)
      if (refused) return refused

      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('id, is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      if (periodError || !period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      if (period.is_closed || period.locked_at || period.closing_entry_id) {
        return errorResponseFromCode('PERIOD_LOCKED', opLog, { requestId })
      }

      await saveTaxAdjustments(
        supabase,
        companyId,
        id,
        user.id,
        validation.data,
      )
      const data = await buildDispositionsProposal(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      if (isPeriodLockRefusal(err)) {
        return errorResponseFromCode('PERIOD_LOCKED', opLog, { requestId })
      }
      opLog.error('bokslutsdispositioner adjustments failed', err as Error)
      return errorResponse(err, opLog, { requestId })
    }
  },
  { requireWrite: true },
)

// ============================================================
// POST: commit a list of dispositions chosen by the user
// ============================================================
const ItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bolagsskatt'),
  }).strict(),
  // Uppskjuten skatt (K3 kap. 29): computed from the saved inputs, nothing to send.
  z.object({
    kind: z.literal('uppskjuten_skatt_kap29'),
  }).strict(),
  // Fond för utvecklingsutgifter (K3): computed from the ledger, nothing to send.
  z.object({
    kind: z.literal('fond_for_utvecklingsutgifter'),
  }).strict(),
  z.object({
    kind: z.literal('sarskild_loneskatt'),
    manualAdjustment: z.number().optional(),
  }),
  z.object({
    kind: z.literal('periodiseringsfond_avsattning'),
    /** Optional override for the SLR-based schablonintäkt rate; defaults to
     *  the server-side constant. Used both to compute the cap base and to
     *  feed back into bolagsskatt's adjustment if present in the same batch.
     *  Bounded to a sane range - an inflated rate would inflate the cap base
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
      const refused = await dispositionsGate(supabase, companyId, opLog, requestId)
      if (refused) return refused

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
        if (item.kind === 'uppskjuten_skatt_kap29') {
          // Its own posting function: the voucher and the items it was
          // computed from in one transaction (commit_deferred_tax).
          const state = await loadDispositionState(supabase, companyId, period)
          const bolagsskatt = bolagsskattDisposition(state, {
            pendingResultEffect: 0,
            schablonintaktAmount: ateforingDispositions(state).schablonintaktAmount,
            uppraekningAmount: fondUppraekning(state).amount,
          })
          const entry = await postDeferredTax(supabase, companyId, user.id, period, {
            closingDeficit: closingDeficitOf(bolagsskatt),
          })
          if (entry) created.push({ kind: item.kind, entry })
          continue
        }
        const proposal = await computeProposal(item, supabase, companyId, period)
        if (!proposal) continue

        // Posting port (step 2g): the engine gets the input unchanged; while
        // POSTING_EVENTS is on, the disposition's year_end.closing event is
        // recorded first and linked to the draft before a number is drawn.
        const entry = await postingPort.postJournalEntry({
          supabase,
          companyId,
          userId: user.id,
          event: () =>
            yearEndDispositionBusinessEvent({
              disposition: proposal.kind,
              fiscalPeriodId: id,
              periodEnd: period.period_end,
              amount: proposal.amount,
              linkBasis: linkBasisColumns('user_created'),
            }),
          input: {
            fiscal_period_id: id,
            entry_date: period.period_end,
            description: `Bokslutsdisposition: ${proposal.label}`,
            source_type: 'year_end',
            source_id: item.kind === 'bolagsskatt' ? id : undefined,
            lines: proposal.lines,
          },
        })
        created.push({ kind: item.kind, entry })
      }

      return NextResponse.json({ data: { created } })
    } catch (err) {
      if (err instanceof OveravskrivningarConflictError) {
        return errorResponseFromCode('CONFLICT', opLog, {
          requestId,
          messageSv: err.message,
          messageEn: err.messageEn,
        })
      }
      if (err instanceof TaxProvisionConflictError) {
        return errorResponseFromCode('CONFLICT', opLog, {
          requestId,
          messageSv:
            'Bolagsskatt finns redan bokförd med ett annat belopp. Rätta den befintliga verifikationen med en ändringsverifikation innan du fortsätter.',
          messageEn:
            'Corporate tax is already posted with a different amount. Correct the existing voucher before continuing.',
          details: {
            bookedAmount: err.bookedAmount,
            expectedAmount: err.expectedAmount,
          },
        })
      }
      if (
        err instanceof BookkeepingDatabaseError
        && err.operation === 'create_draft_entry'
        && err.cause?.includes('uq_year_end_corporate_tax_per_period')
      ) {
        return errorResponseFromCode('CONFLICT', opLog, {
          requestId,
          messageSv: 'Bolagsskatten bokförs redan. Ladda om sidan innan du fortsätter.',
          messageEn: 'Corporate tax is already being posted. Reload the page before continuing.',
        })
      }
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

class TaxProvisionConflictError extends Error {
  constructor(
    readonly bookedAmount: number,
    readonly expectedAmount: number,
  ) {
    super('Booked corporate tax differs from the current calculation')
  }
}

class OveravskrivningarConflictError extends Error {
  constructor(
    message: string,
    readonly messageEn: string,
  ) {
    super(message)
    this.name = 'OveravskrivningarConflictError'
  }
}

async function computeProposal(
  item: PostItem,
  supabase: SupabaseClient,
  companyId: string,
  period: ValidatedPeriod,
): Promise<ProposedDisposition | null> {
  const fiscalPeriodId = period.id
  switch (item.kind) {
    case 'uppskjuten_skatt_kap29':
      // Posted by postDeferredTax in the POST loop, never here.
      return null
    case 'fond_for_utvecklingsutgifter': {
      const form = await resolveCompanyEntityType(supabase, companyId)
      const fund = await buildDevelopmentFundProposal(supabase, companyId, fiscalPeriodId, form)
      return fund?.proposal ?? null
    }
    case 'bolagsskatt': {
      // The preview's own computation (bolagsskattDisposition) on the ledger
      // as it stands now: bolagsskatt is sorted LAST, so every disposition of
      // this batch is posted and in the year's result, nothing is pending.
      const state = await loadDispositionState(supabase, companyId, period)
      const proposal = bolagsskattDisposition(state, {
        pendingResultEffect: 0,
        schablonintaktAmount: ateforingDispositions(state).schablonintaktAmount,
        uppraekningAmount: fondUppraekning(state).amount,
      })
      if (state.bookedTax > 0 && state.bookedTax === proposal.amount) return null
      if (state.bookedTax > 0) throw new TaxProvisionConflictError(state.bookedTax, proposal.amount)
      return proposal.amount > 0 ? proposal : null
    }
    case 'sarskild_loneskatt': {
      // A resumed run or a duplicate POST proposes nothing: the calculator
      // subtracts what is already on 7533.
      return calculateSarskildLoneskatt(supabase, companyId, fiscalPeriodId, {
        manualAdjustment: item.manualAdjustment,
      })
    }
    case 'periodiseringsfond_avsattning': {
      // The preview's cap base (avsattningDisposition), re-derived from the
      // current ledger so the user cannot sneak in a higher desiredAmount than
      // 25 % of the actual skattemässigt resultat. Återföring, över-
      // avskrivningar and SLP are sorted before avsättning, so they are posted
      // and in the year's result: nothing is pending. A posted current-year
      // avsättning is a completed decision: never topped up (null).
      const state = await loadDispositionState(supabase, companyId, period)
      return avsattningDisposition(state, {
        pendingResultEffect: 0,
        schablonintaktAmount: ateforingDispositions(state, {
          schablonintaktRate: item.schablonintaktRate,
        }).schablonintaktAmount,
        uppraekningAmount: fondUppraekning(state).amount,
        desiredAmount: item.desiredAmount,
      })
    }
    case 'periodiseringsfond_ateforing': {
      // Recompute existing fonder server-side so the user can't return more
      // than is on the books.
      const state = await loadDispositionState(supabase, companyId, period)
      const result = ateforingDispositions(state, {
        returns: item.returns,
        schablonintaktRate: item.schablonintaktRate,
      })
      // Combine multiple cohort reversals into a single voucher with multiple
      // lines so we don't blow up voucher numbering, but each fond is its own
      // line pair already. Build a merged ProposedDisposition.
      if (result.proposals.length === 0) return null
      return mergeAteforingProposals(result.proposals)
    }
    case 'overavskrivningar': {
      if (item.category && item.category !== 'machinery_equipment') {
        throw new OveravskrivningarConflictError(
          'Den automatiska beräkningen omfattar endast maskiner och inventarier enligt IL 18 kap.',
          'The automatic calculation only covers machinery and equipment under Chapter 18 of the Income Tax Act.',
        )
      }
      const calculation = await calculateOveravskrivningar({
        supabase,
        companyId,
        fiscalPeriod: period,
      })
      if (calculation.status === 'blocked') {
        throw new OveravskrivningarConflictError(
          calculation.warning ?? 'Överavskrivningen kan inte beräknas säkert.',
          'The excess depreciation cannot be calculated safely.',
        )
      }
      if (!calculation.proposal) return null

      const requested = roundOre(item.additionalAmount)
      const maximum = calculation.proposal.signedAmount ?? calculation.proposal.amount
      const invalidIncrease = maximum > 0 && (requested <= 0 || requested > maximum)
      const invalidRelease = maximum < 0 && requested !== maximum
      if (invalidIncrease || invalidRelease) {
        throw new OveravskrivningarConflictError(
          'Beloppet är inte längre giltigt. Ladda om bokslutet och använd den aktuella beräkningen.',
          'The amount is no longer valid. Reload the year-end flow and use the current calculation.',
        )
      }

      return proposeOveravskrivningar({
        additionalAmount: requested,
        category: 'machinery_equipment',
        computation: calculation.proposal.computation,
      })
    }
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
