import { defineAgentIntent } from './types'
import { OPUS_MODEL } from '@/lib/agent/composer/client'
import { renderAgentGroundRules } from './shared-rules'
import type { PeriodStatusValue } from '@/lib/core/bookkeeping/period-service'

// bokslut.step: "Fråga [namn]" inside the year-end (bokslut) wizard.
//
// Bokslut is where users feel the most stress: many decisions (periodisering,
// avskrivningar, dispositioner, tax provision), each with K2/K3 implications,
// and irreversible once locked. The agent explains the current step, the
// state, and what's recommended given the company's signals.
//
// Declarative atoms: year-end-closing + financial-reporting + tax-planning +
// asset-accounting. Heavy load by design; this is when the user wants the
// full reasoning depth.
//
// Opus per plan §8 V1 #6: multi-step reasoning across rules + balances.

interface BokslutStepArgs {
  // The bokslut wizard's step id, e.g. 'accruals', 'depreciation',
  // 'dispositioner', 'tax-provision', 'arsredovisning'. Empty = overview.
  step_id?: string | null
  fiscal_year_end?: string | null
}

interface CapturedBokslutStep {
  step_id: string | null
  fiscal_period: {
    id: string | null
    period_start: string | null
    period_end: string | null
    // Canonical three-value period state, derived from is_closed + locked_at
    // the same way lib/core/bookkeeping/period-service.ts derives it.
    status: PeriodStatusValue
    lock_date: string | null
  } | null
  // True when the fiscal_periods lookup itself failed. Distinct from
  // fiscal_period === null (no period row), which is the "no räkenskapsår
  // exists yet" case. Both mean the year state is UNKNOWN, never "open".
  period_lookup_failed: boolean
  entity_type: string | null
}

const PERIOD_STATUS_SV: Record<PeriodStatusValue, string> = {
  open: 'öppen',
  locked: 'låst',
  closed: 'stängd',
}

export const bokslutStep = defineAgentIntent<BokslutStepArgs, CapturedBokslutStep>({
  id: 'bokslut.step',
  buttonLabel: 'Fråga om detta steg',
  sheetTitle: 'Hjälp med bokslut',

  atoms: {
    mode: 'declarative',
    horizontal: [
      'swedish-year-end-closing',
      'swedish-financial-reporting',
      'swedish-tax-planning',
      'swedish-asset-accounting',
      'swedish-accounting-compliance',
    ],
    includeCompanyVertical: true,
    includeCompanyModifiers: true,
  },

  tools: [
    'gnubok_year_end_readiness',
    'gnubok_post_kontantmetod_cutoff',
    'gnubok_list_fiscal_periods',
    'gnubok_propose_accruals',
    'gnubok_propose_annual_depreciation',
    'gnubok_propose_dispositioner',
    'gnubok_preview_arsredovisning',
    'gnubok_preview_ef_declaration',
    'gnubok_get_trial_balance',
    'gnubok_get_balance_sheet',
    'gnubok_get_income_statement',
    'gnubok_load_skill',
    'gnubok_search_tools',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: OPUS_MODEL,

  capture: async ({ step_id, fiscal_year_end }, { supabase, companyId }) => {
    // Find the latest fiscal period (the one being closed): or the one
    // matching fiscal_year_end if supplied.
    //
    // fiscal_periods has NO `status` column. Period state lives in
    // `is_closed` + `locked_at`, which is what period-service.ts
    // (resolvePeriodStatusForDate) and the DB period-lock triggers read.
    // Selecting a non-existent column makes PostgREST reject the whole
    // query, so the period would never resolve at all.
    let query = supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end, is_closed, locked_at')
      .eq('company_id', companyId)
    if (fiscal_year_end) query = query.eq('period_end', fiscal_year_end)
    query = query.order('period_end', { ascending: false }).limit(1)
    const { data: period, error: periodError } = await query.maybeSingle()

    const { data: company } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .maybeSingle()

    const row = periodError
      ? null
      : (period as {
          id: string
          period_start?: string | null
          period_end?: string | null
          is_closed?: boolean | null
          locked_at?: string | null
        } | null)

    return {
      step_id: step_id ?? null,
      period_lookup_failed: !!periodError,
      fiscal_period: row
        ? {
            id: row.id,
            period_start: row.period_start ?? null,
            period_end: row.period_end ?? null,
            // Same precedence as resolvePeriodStatusForDate: closed wins
            // over locked, locked wins over open.
            status: row.is_closed ? 'closed' : row.locked_at ? 'locked' : 'open',
            lock_date: row.locked_at ?? null,
          }
        : null,
      entity_type: ((company as { entity_type?: string | null } | null)?.entity_type) ?? null,
    }
  },

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push('Användaren är i bokslutsguiden och behöver hjälp.')
    if (captured.step_id) lines.push(`Aktivt steg: ${captured.step_id}`)
    if (captured.fiscal_period) {
      const period = captured.fiscal_period
      lines.push(
        `Räkenskapsår: ${period.period_start ?? '?'} → ${period.period_end ?? '?'} (status: ${PERIOD_STATUS_SV[period.status]})`,
      )
      if (period.status === 'closed') {
        lines.push(
          'Perioden är STÄNGD. Databasens periodlås avvisar nya bokföringsposter i perioden. Föreslå inga bokningar i räkenskapsåret: hänvisa till rättelse enligt BFL 5 kap 5 § (storno) om något behöver korrigeras.',
        )
      } else if (period.status === 'locked') {
        lines.push(
          `Perioden är LÅST${period.lock_date ? ` (låst ${period.lock_date})` : ''}. Databasens periodlås avvisar nya bokföringsposter tills en behörig användare låser upp perioden. Föreslå inga bokningar innan dess: säg att perioden måste låsas upp först.`,
        )
      }
    } else {
      // Fail closed: an errored lookup or a missing period row is NOT an open
      // year. Never let the agent reason as if bokslutsposter can be booked.
      lines.push(
        captured.period_lookup_failed
          ? 'VARNING: uppslaget av räkenskapsåret misslyckades (databasfel). Räkenskapsårets status är OKÄND.'
          : 'VARNING: inget räkenskapsår hittades för företaget. Räkenskapsårets status är OKÄND.',
      )
      lines.push(
        'Anta INTE att året är öppet. Kör gnubok_year_end_readiness och gnubok_list_fiscal_periods, och bekräfta räkenskapsåret med användaren INNAN du föreslår eller stagear någon bokslutspost.',
      )
    }
    if (captured.entity_type) lines.push(`Företagsform: ${captured.entity_type}`)
    lines.push('')
    lines.push(renderAgentGroundRules())
    lines.push('')
    lines.push('Arbetssätt: hjälp användaren genom STEGET de står i:')
    lines.push('1. Kör gnubok_year_end_readiness för att se vad som saknas.')
    lines.push('2. Om kontantmetodens bokslutsavgränsning blockerar: använd gnubok_post_kontantmetod_cutoff, visa alla föreslagna verifikat och vändningar, och inhämta uttryckligt godkännande före bokföring.')
    lines.push('3. Om steget är "accruals": använd gnubok_propose_accruals för periodiseringar och förklara varje förslag (när påverkar det BR/RR, varför detta belopp?).')
    lines.push('4. Om steget är "depreciation": gnubok_propose_annual_depreciation. Förklara planenlig vs. överavskrivning, K2 schablonregler vs. K3 individual.')
    lines.push('5. Om steget är "dispositioner": gnubok_propose_dispositioner. Periodiseringsfond, koncernbidrag (om holding), årets skatt.')
    lines.push('6. Om steget är "arsredovisning": preview via gnubok_preview_arsredovisning, granska noter, förvaltningsberättelse, underskrifter, deadline.')
    lines.push('7. Om EF: använd gnubok_preview_ef_declaration. Räntefördelning, expansionsfond, NE-bilaga.')
    lines.push('')
    lines.push('Var BFL-rigorös: bokslut är irreversibelt när det låses. Peka på risker innan du föreslår staging av en operation.')
    lines.push('Svara på svenska. Ditt första svar är det första användaren ser: gå rakt på sak.')
    return lines.join('\n')
  },
})
