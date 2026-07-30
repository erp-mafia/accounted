import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { generateIncomeStatement } from './income-statement'
import { generateINK2Declaration } from './ink2/ink2-engine'
import { generateNEDeclaration } from './ne-bilaga/ne-engine'

/**
 * Årets resultat, as every surface reports it, side by side.
 *
 * Every year-end problem a customer has reported was a DISAGREEMENT between two
 * of our own screens, not a single wrong screen: the årsredovisning said one
 * figure and INK2 said another, so the customer did the reconciliation for us.
 * This puts the comparison in the product.
 *
 * Two families, and the distinction is load-bearing:
 *
 *   ledger + statutory  must agree exactly (bar öre truncation). Both describe
 *                       the position after bokslut. A mismatch here is a bug or
 *                       an unfinished bokslut, and is reported as such.
 *   operational         reports the result BEFORE bokslutsdispositioner and
 *                       skatt, so it legitimately differs today. The gap is
 *                       explained rather than flagged. When Stage 2 of #1051
 *                       lands (DECISIONS.md:632) the families converge and
 *                       EXPECTED_OPERATIONAL_GAP can be dropped.
 *
 * Swedish labels: this surfaces next to the bokslut and declaration figures
 * (see .claude/rules/i18n.md).
 */

/** Öre truncation across a form can legitimately accumulate a krona or two. */
const TOLERANCE_KR = 2

export type ReconciliationFamily = 'ledger' | 'statutory' | 'operational'

export interface ReconciliationFigure {
  /** Swedish surface name, as the user sees it in the app. */
  surface: string
  family: ReconciliationFamily
  /** Whole kronor, or null when the surface cannot produce a figure. */
  aretsResultat: number | null
  /** Why the figure is null, or why it legitimately differs. */
  note?: string
}

export interface StatementReconciliation {
  fiscalYear: { id: string; name: string; start: string; end: string; isClosed: boolean }
  figures: ReconciliationFigure[]
  /** Human-readable mismatches that need attention. Empty means reconciled. */
  disagreements: string[]
  isReconciled: boolean
}

function truncate(value: number): number {
  return value >= 0 ? Math.floor(value) : Math.ceil(value)
}

/**
 * Read the booked årets resultat off konto 2099 in the CLOSED books. 2099 holds
 * only the current year's result under K2: the prior year's is moved to 2098 by
 * the next year's resultatdisposition.
 */
async function bookedResult(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<number> {
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    closingEntry: 'include',
  })
  const row = rows.find((r) => r.account_number === '2099')
  if (!row) return 0
  return truncate((Number(row.closing_credit) || 0) - (Number(row.closing_debit) || 0))
}

export async function reconcileStatements(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<StatementReconciliation> {
  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, is_closed')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (error || !period) {
    throw new Error('Fiscal period not found')
  }

  const figures: ReconciliationFigure[] = []
  const disagreements: string[] = []

  // ── Ledger ────────────────────────────────────────────────────
  const booked = await bookedResult(supabase, companyId, fiscalPeriodId)
  figures.push({
    surface: 'Bokfört resultat (konto 2099)',
    family: 'ledger',
    aretsResultat: booked,
    note: period.is_closed
      ? undefined
      : 'Räkenskapsåret är inte stängt, så resultatet ligger kvar på resultatkontona.',
  })

  // ── Statutory: whichever declaration applies to this entity ───
  // Dispatched on entity_type, NOT by calling a generator and catching its
  // throw. Catch-as-control-flow swallowed genuine failures too (an internal
  // computation error, or generateTrialBalance's closing_entry_id guard on a
  // closed period) and mapped them to a null figure, which the comparison below
  // skips, so a real bug in the declaration generator made this function report
  // isReconciled: true. That is the exact opposite of what it exists to do.
  const entityType = await resolveEntityType(supabase, companyId)

  if (entityType === 'aktiebolag' || entityType === 'enskild_firma') {
    try {
      if (entityType === 'aktiebolag') {
        const ink2 = await generateINK2Declaration(supabase, companyId, fiscalPeriodId)
        figures.push({
          surface: 'INK2R (3.26/3.27)',
          family: 'statutory',
          aretsResultat: ink2.ink2r['7450'] - ink2.ink2r['7550'],
        })
      } else {
        const ne = await generateNEDeclaration(supabase, companyId, fiscalPeriodId)
        figures.push({
          surface: 'NE-bilaga (R11)',
          family: 'statutory',
          aretsResultat: ne.rutor.R11,
          note: 'NE-bilagan redovisar resultatet före skatt; skatten beskattas hos ägaren.',
        })
      }
    } catch (err) {
      // The applicable declaration exists but could not be produced. That is a
      // finding, not an absence: surface it instead of returning "reconciled".
      const reason = err instanceof Error ? err.message : String(err)
      figures.push({
        surface: entityType === 'aktiebolag' ? 'INK2R (3.26/3.27)' : 'NE-bilaga (R11)',
        family: 'statutory',
        aretsResultat: null,
        note: `Deklarationen kunde inte genereras: ${reason}`,
      })
      disagreements.push(
        `Deklarationen kunde inte genereras och kan därför inte stämmas av mot bokföringen: ${reason}`,
      )
    }
  } else {
    figures.push({
      surface: 'Deklaration',
      family: 'statutory',
      aretsResultat: null,
      note: 'Ingen deklarationsblankett stöds för den här företagsformen.',
    })
  }

  // ── Operational ───────────────────────────────────────────────
  const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
  figures.push({
    surface: 'Resultaträkning',
    family: 'operational',
    aretsResultat: truncate(incomeStatement.net_result),
    note: 'Visar resultatet före bokslutsdispositioner och skatt.',
  })

  // ── Compare within the families that must agree ───────────────
  const statutory = figures.find((f) => f.family === 'statutory')
  if (
    period.is_closed
    && statutory?.aretsResultat !== null
    && statutory?.aretsResultat !== undefined
    && Math.abs(statutory.aretsResultat - booked) > TOLERANCE_KR
  ) {
    disagreements.push(
      `${statutory.surface} visar ${statutySafe(statutory.aretsResultat)} kr medan bokföringen visar ${booked} kr på konto 2099. Deklarationen stämmer inte med det fastställda bokslutet.`,
    )
  }

  return {
    fiscalYear: {
      id: period.id as string,
      name: period.name as string,
      start: period.period_start as string,
      end: period.period_end as string,
      isClosed: period.is_closed as boolean,
    },
    figures,
    disagreements,
    isReconciled: disagreements.length === 0,
  }
}

/** Narrow a possibly-null figure for message interpolation. */
function statutySafe(value: number | null): number {
  return value ?? 0
}

/**
 * Resolve the entity type the same way the declaration engines do: prefer
 * company_settings, fall back to companies.entity_type (NOT NULL, always set).
 *
 * The companies error is THROWN, not swallowed. Returning null on a genuine DB
 * failure (RLS, permissions, connectivity) would be indistinguishable from "no
 * entity type set", which lands in the unsupported-form branch and reports
 * isReconciled: true: the same silent-false-reconciled bug this module exists to
 * close, one level down. A missing company_settings ROW is different and stays
 * tolerated, because .single() errors on zero rows and many companies have none.
 */
async function resolveEntityType(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .single()
  if (settings?.entity_type) return settings.entity_type as string

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('entity_type')
    .eq('id', companyId)
    .single()
  if (companyError) {
    throw new Error(`Failed to resolve entity type: ${companyError.message}`)
  }
  return (company?.entity_type as string | undefined) ?? null
}
