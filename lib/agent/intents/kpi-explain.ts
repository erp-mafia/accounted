import { defineAgentIntent } from './types'
import { SONNET_MODEL } from '@/lib/agent/composer/client'

// kpi.explain — "Förklara siffran" on a KPI card / nyckeltal.
//
// The user sees a number ("rörelsemarginal 12 %") and wants to know what
// drove it, how it compares to last period, and whether it's healthy for
// their type of business. The agent reads the trial balance / income
// statement, surfaces the underlying accounts, and contextualizes.
//
// Light-touch intent — captures only what the user looked at. The agent
// fetches the rest via tools.

interface KpiExplainArgs {
  kpi_key: string
  value?: number | null
  period_label?: string | null
  trend?: string | null
}

interface CapturedKpiExplain {
  kpi_key: string
  value: number | null
  period_label: string | null
  trend: string | null
}

export const kpiExplain = defineAgentIntent<KpiExplainArgs, CapturedKpiExplain>({
  id: 'kpi.explain',
  buttonLabel: 'Förklara denna siffra',
  sheetTitle: 'Förklara nyckeltalet',

  atoms: {
    mode: 'declarative',
    horizontal: ['swedish-financial-reporting'],
    includeCompanyVertical: true,
    includeCompanyModifiers: false,
  },

  tools: [
    'gnubok_get_kpi_report',
    'gnubok_get_income_statement',
    'gnubok_get_balance_sheet',
    'gnubok_get_general_ledger',
    'gnubok_query_journal',
    'gnubok_load_skill',
    'gnubok_search_tools',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: SONNET_MODEL,

  capture: async ({ kpi_key, value, period_label, trend }) => ({
    kpi_key,
    value: value ?? null,
    period_label: period_label ?? null,
    trend: trend ?? null,
  }),

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push(`Användaren tittar på nyckeltalet "${captured.kpi_key}".`)
    if (captured.value != null) {
      lines.push(`Visat värde: ${captured.value.toLocaleString('sv-SE')}`)
    }
    if (captured.period_label) lines.push(`Period: ${captured.period_label}`)
    if (captured.trend) lines.push(`Trend: ${captured.trend}`)
    lines.push('')
    lines.push('Arbetssätt:')
    lines.push('1. Förklara KORT vad nyckeltalet mäter och hur det räknas ut (formel + ingående konton).')
    lines.push('2. Hämta gnubok_get_kpi_report / gnubok_get_income_statement för att se vad som driver siffran just nu.')
    lines.push('3. Peka på vad användaren kan göra om siffran är låg eller hög — utan att moralisera.')
    lines.push('4. Om det är ovanligt för deras bransch eller jämförelseperiod, säg det.')
    lines.push('')
    lines.push('Svara på svenska, max 4–5 korta stycken. Ditt första svar är det första användaren ser.')
    return lines.join('\n')
  },
})
