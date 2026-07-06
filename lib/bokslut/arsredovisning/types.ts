/**
 * Structured data for a K2 årsredovisning. Generated server-side from
 * income statement + balance sheet + asset register + salary data; passed
 * to the @react-pdf/renderer template + the in-app preview.
 */

export interface FlerarsoversiktRow {
  /** Fiscal-year name (e.g. "2025"). */
  year: string
  net_revenue: number
  result_after_financial: number
  /** Soliditet = eget kapital / totala tillgångar, in percent. */
  soliditet_pct: number | null
}

export interface EgenKapitalRow {
  label: string
  /** Single SEK number: positive = credit balance (typical for equity). */
  amount: number
}

export interface NoteEntry {
  /** Note number per K2 convention (1 = redovisningsprinciper). */
  number: number
  /** Short Swedish title. */
  title: string
  /** Note body: supports newlines. Generated from data when possible
   *  (avskrivningstider from asset register, medelantal from salary),
   *  manual otherwise. */
  body: string
}

/**
 * One presentation row of the RR/BR in ÅRL uppställningsform. Post-level
 * only — labels must never contain BAS account numbers (Bolagsverket
 * rejects balans-/resultaträkningar med kontonummer). Rows are derived
 * from the K2 risbs mapping in lib/bokslut/arsredovisning/statement-rows.ts.
 */
export interface StatementRow {
  label: string
  /** Whole-SEK amount for the current year; null on heading rows. */
  current: number | null
  /** Previous-year amount (jämförelseår, ÅRL 3:5 §); null on heading rows
   *  and when the company has no previous fiscal year. */
  previous: number | null
  /** Subtotal/total rows render bold with a top border. */
  is_total?: boolean
  /** Section headings carry no amounts. */
  is_heading?: boolean
  /** Indent depth (0 = section, 1 = subsection, 2 = post under subsection). */
  indent?: number
}

export interface ArsredovisningData {
  company: {
    name: string
    org_number: string
    /** Företagets säte (Bolagsverket-registered registered office city).
     *  Used in the underskrifter "Stad, datum" line and the fastställelseintyg. */
    city: string | null
  }
  fiscal_period: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  /** Previous fiscal period backing the jämförelseår column (ÅRL 3:5 §).
   *  Null for the company's first fiscal year, or when the previous year's
   *  trial balance could not be generated (a warning is emitted then). */
  previous_period: {
    name: string
    period_start: string
    period_end: string
  } | null
  /** Which BFNAR framework the document was generated under. Drives PDF
   *  rendering branching (K3 has an additional kassaflöde + equity-changes
   *  page and a richer note set) and lets the UI label the document
   *  correctly. K2 is the default for AB without an explicit election. */
  accounting_framework: 'k2' | 'k3'
  forvaltningsberattelse: {
    /** Beskrivning av verksamheten (företaget kan editera). */
    description: string
    /** Viktiga händelser (företaget kan editera). */
    important_events: string
    /** Har kontrollbalansräkning upprättats? */
    kontrollbalans_required: boolean
    flerarsoversikt: FlerarsoversiktRow[]
    /** Förändring av eget kapital. */
    egen_kapital_changes: EgenKapitalRow[]
    /** Styrelsens förslag till resultatdisposition (manual input). */
    resultatdisposition: string
    /** ISO date of the årsstämma where the årsredovisning was adopted.
     *  Populates the fastställelseintyg date blank. Null means "not yet
     *  recorded": PDF then leaves the blank. */
    agm_date: string | null
  }
  resultatrakning: StatementRow[]
  balansrakning: {
    assets: StatementRow[]
    total_assets: number
    /** Jämförelseår total; null when previous_period is null. */
    total_assets_previous: number | null
    equity_liabilities: StatementRow[]
    total_equity_liabilities: number
    total_equity_liabilities_previous: number | null
  }
  noter: NoteEntry[]
  /** K3-only: full kassaflödesanalys (indirect method) rendered as its own
   *  PDF page. K2 omits this entirely (per BFNAR 2016:10 kassaflöde is not
   *  required for K2 mindre företag). */
  kassaflodesanalys?: KassaflodesAnalysisSummary
  /** K3-only: separate "Förändring av eget kapital" statement. K2 keeps the
   *  egen_kapital_changes inside förvaltningsberättelsen; K3 lifts it out
   *  into its own statement per ÅRL 6:5 + BFNAR 2012:1 ch.6. */
  equity_changes_statement?: {
    rows: EgenKapitalRow[]
    closing_total: number
  }
  /** Underskrifter: names of board members + VD. Filled by signature flow. */
  signatures: {
    role: string
    name: string
    signed_at: string | null
  }[]
  /** Pre-download blockers / warnings the UI surfaces so the user knows the
   *  PDF is not yet Bolagsverket-fileable as-is. Examples: aktiekapital
   *  uppgifter saknas, AGM-datum saknas, K3 entity. Never an error: the
   *  user can still download to iterate. */
  warnings: string[]
  /** Manual disclosure overrides persisted on arsredovisning_narratives.
   *  Drive the long-term debt, säkerheter, eventualförpliktelser, and
   *  koncernförhållanden notes. Null means "use the boilerplate". */
  disclosures: {
    long_term_debt_over_five_years: number | null
    securities_pledged: string | null
    contingent_liabilities: string | null
    parent_company_name: string | null
    parent_company_org_number: string | null
    parent_company_city: string | null
  }
}

/**
 * Light summary of kassaflödesanalys carried in ArsredovisningData. We
 * embed a flat shape rather than the full KassaflodesanalysReport so that
 * the data builder can produce it without forcing all callers / tests to
 * also mock the kassaflöde generator. The K3 PDF renderer reads only these
 * fields; if you need the full structured report use generateKassaflodesanalys
 * directly.
 */
export interface KassaflodesAnalysisSummary {
  period_start: string
  period_end: string
  lopande: {
    resultat_efter_finansiella_poster: number
    avskrivningar: number
    ovriga_ej_kassaflodesposter: number
    delta_kortfristiga_fordringar: number
    delta_varulager: number
    delta_kortfristiga_skulder: number
    skatt_betald: number
    total: number
  }
  investerings: {
    forvarv_anlaggningar: number
    avyttring_anlaggningar: number
    total: number
  }
  finansierings: {
    delta_lan: number
    utdelningar: number
    nyemission: number
    erhallna_aktieagartillskott: number
    total: number
  }
  total_cash_flow: number
  reconciliation: {
    opening_cash_1xxx: number
    closing_cash_1xxx: number
    delta_actual: number
    delta_calculated: number
    mismatch_amount: number
    is_reconciled: boolean
  }
}
