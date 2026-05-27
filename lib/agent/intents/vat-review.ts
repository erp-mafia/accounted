import { defineAgentIntent } from './types'
import { OPUS_MODEL, THINKING_BUDGET_DEEP } from '@/lib/agent/composer/client'
import { renderAgentGroundRules } from './shared-rules'

// vat.review — "Fråga [namn]" from the VAT declaration preview.
//
// Highest-stakes regular intent: the user is about to submit a momsdeklaration
// and wants a sanity check. The agent reads the Rutor (05–62), spots
// anomalies vs. the prior period, validates that one-sided reverse-charge
// flags balance, and points out filing/payment deadlines.
//
// Declarative atoms: swedish-vat (essential), plus accounting-compliance and
// the company's vertical/modifier so industry-specific quirks fire
// (restaurang's 12/25 % split, bygg's omvänd skattskyldighet, e-handel OSS).
//
// Opus per plan §8 V1 #7 — anomaly + cross-check reasoning rewards deeper
// reasoning than Sonnet.

interface VatReviewArgs {
  period_type?: 'monthly' | 'quarterly' | 'yearly'
  year?: number
  period?: number
}

interface CapturedVatReview {
  period: {
    period_type: string | null
    year: number | null
    period: number | null
    label: string | null
  }
  company_moms_period: string | null
  filing_deadline: string | null
}

export const vatReview = defineAgentIntent<VatReviewArgs, CapturedVatReview>({
  id: 'vat.review',
  buttonLabel: 'Fråga om denna deklaration',
  sheetTitle: 'Granska momsdeklaration',

  atoms: {
    mode: 'declarative',
    horizontal: ['swedish-vat', 'swedish-accounting-compliance'],
    includeCompanyVertical: true,
    includeCompanyModifiers: true,
  },

  // Agent reads the actual Rutor via the tool; we don't capture them server-
  // side because the report is large and version-sensitive.
  tools: [
    'gnubok_get_vat_report',
    'gnubok_vat_close_check',
    'gnubok_query_journal',
    'gnubok_load_skill',
    'gnubok_search_tools',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: OPUS_MODEL,

  // Reason over the period figures + Rutor in the thinking channel, so the
  // visible reply is one conclusion, not a running commentary of each read
  // followed by a restated summary. Parity with the other reasoning intents.
  thinking: { budgetTokens: THINKING_BUDGET_DEEP },

  capture: async ({ period_type, year, period }, { supabase, companyId }) => {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('moms_period')
      .eq('company_id', companyId)
      .maybeSingle()
    const momsPeriod = (settings as { moms_period?: string | null } | null)?.moms_period ?? null

    // Period defaulting: if the caller didn't specify, use the company's
    // declared period and the most recent applicable bucket.
    const now = new Date()
    const resolvedType =
      period_type ??
      (momsPeriod === 'yearly' ? 'yearly' : momsPeriod === 'monthly' ? 'monthly' : 'quarterly')
    const resolvedYear = year ?? now.getFullYear()
    let resolvedPeriod: number | undefined = period
    if (resolvedPeriod == null) {
      if (resolvedType === 'monthly') resolvedPeriod = now.getMonth() // previous month
      else if (resolvedType === 'quarterly') resolvedPeriod = Math.floor(now.getMonth() / 3) || 4
      else resolvedPeriod = 1
    }

    const label =
      resolvedType === 'yearly'
        ? `${resolvedYear}`
        : resolvedType === 'quarterly'
          ? `Q${resolvedPeriod} ${resolvedYear}`
          : `${resolvedYear}-${String(resolvedPeriod).padStart(2, '0')}`

    return {
      period: {
        period_type: resolvedType,
        year: resolvedYear,
        period: resolvedPeriod ?? null,
        label,
      },
      company_moms_period: momsPeriod,
      filing_deadline: null,
    }
  },

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push('Användaren granskar en momsdeklaration innan inlämning.')
    lines.push('')
    lines.push(renderAgentGroundRules())
    lines.push('')
    lines.push(`Period: ${captured.period.label ?? '?'} (${captured.period.period_type ?? '?'})`)
    if (captured.company_moms_period) {
      lines.push(`Företagets momsperiod: ${captured.company_moms_period}`)
    }
    lines.push('')
    lines.push('Arbetssätt:')
    lines.push('1. Hämta declarationen med gnubok_get_vat_report (period_type, year, period).')
    lines.push('2. Hämta gnubok_vat_close_check för pre-filing varningar (t.ex. ensidig reverse charge utan motpost).')
    lines.push('3. Återrapportera Rutor 05–62 i ett kort format användaren kan ögna igenom: SE-försäljning, EU-tjänster, export, ingående/utgående moms per skattesats, reverse-charge-vyer, samt Ruta 49 (att betala / återfå).')
    lines.push('4. Varna explicit för anomalier: stora avvikelser mot förra perioden, oväntade reverse-charge-belopp, saknad motpost.')
    lines.push('5. Påminn om deadline (deklarationsdatum + betalningsdatum) och rekommendera fortsatta steg om allt ser bra ut.')
    lines.push('')
    lines.push('Svara på svenska, kort och konkret. Använd tabellform när det hjälper användaren skanna siffrorna. Ditt första svar är det första användaren ser.')
    return lines.join('\n')
  },
})
