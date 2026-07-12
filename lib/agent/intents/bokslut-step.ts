import { defineAgentIntent } from './types'
import { OPUS_MODEL } from '@/lib/agent/composer/client'
import { renderAgentGroundRules } from './shared-rules'

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
    status: string | null
  } | null
  entity_type: string | null
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
    // Find the latest non-locked fiscal period (the one being closed): or
    // the one matching fiscal_year_end if supplied.
    let query = supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end, status')
      .eq('company_id', companyId)
    if (fiscal_year_end) query = query.eq('period_end', fiscal_year_end)
    query = query.order('period_end', { ascending: false }).limit(1)
    const { data: period } = await query.maybeSingle()

    const { data: company } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .maybeSingle()

    return {
      step_id: step_id ?? null,
      fiscal_period: period
        ? {
            id: (period as { id: string }).id,
            period_start: ((period as { period_start?: string | null }).period_start) ?? null,
            period_end: ((period as { period_end?: string | null }).period_end) ?? null,
            status: ((period as { status?: string | null }).status) ?? null,
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
      lines.push(
        `Räkenskapsår: ${captured.fiscal_period.period_start ?? '?'} → ${captured.fiscal_period.period_end ?? '?'} (status: ${captured.fiscal_period.status ?? '?'})`,
      )
    }
    if (captured.entity_type) lines.push(`Företagsform: ${captured.entity_type}`)
    lines.push('')
    lines.push(renderAgentGroundRules())
    lines.push('')
    lines.push('Arbetssätt: hjälp användaren genom STEGET de står i:')
    lines.push('1. Kör gnubok_year_end_readiness för att se vad som saknas.')
    lines.push('2. Om steget är "accruals": använd gnubok_propose_accruals för periodiseringar och förklara varje förslag (när påverkar det BR/RR, varför detta belopp?).')
    lines.push('3. Om steget är "depreciation": gnubok_propose_annual_depreciation. Förklara planenlig vs. överavskrivning, K2 schablonregler vs. K3 individual.')
    lines.push('4. Om steget är "dispositioner": gnubok_propose_dispositioner. Periodiseringsfond, koncernbidrag (om holding), årets skatt.')
    lines.push('5. Om steget är "arsredovisning": preview via gnubok_preview_arsredovisning, granska noter, förvaltningsberättelse, underskrifter, deadline.')
    lines.push('6. Om EF: använd gnubok_preview_ef_declaration. Räntefördelning, expansionsfond, NE-bilaga.')
    lines.push('')
    lines.push('Var BFL-rigorös: bokslut är irreversibelt när det låses. Peka på risker innan du föreslår staging av en operation.')
    lines.push('Svara på svenska. Ditt första svar är det första användaren ser: gå rakt på sak.')
    return lines.join('\n')
  },
})
