import type { KassaflodesanalysReport } from '@/lib/reports/kassaflodesanalys'
import type { EquitySpecification } from './equity-specification'
import type { EquityMovementKind } from './equity-kinds'
import type { DisclosureAnswers, DisclosureEvaluation, K3FirstYearStatus } from './disclosures/types'

/**
 * A förvaltningsberättelse text the K3 disclosure matrix adds, with the K3
 * taxonomy (fdr) concept it is tagged with in iXBRL (the K3 iXBRL adapter,
 * ixbrl/k3-adapters.ts, reads this shape).
 */
export interface K3ForvaltningsberattelseItem {
  concept: string | null
  heading: string
  text: string
}

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
  /** Stable key on notes whose text the user may replace (note-overrides.ts). */
  key?: string
  /** The generated text, present only when the user replaced the body. */
  generated_body?: string
}

/** See cash-flow-omission.ts for the legal rule behind these values. */
export type CashFlowOmissionRule = 'allowed' | 'requires_confirmation' | 'forbidden'

export interface CashFlowOmissionState {
  /** What the product may do for this company and year. */
  rule: CashFlowOmissionRule
  /** The user asked to leave the statement out (persisted choice). */
  requested: boolean
  /** The user confirmed the company is not a större företag. */
  confirmed: boolean
  /** Final outcome: the statement is left out of this document. */
  omitted: boolean
  /** K3 mindre företag: left out by the product whatever the choice, until
   *  the statement meets K3 kapitel 7 (model.ts applyCashFlowOmission). */
  withheld?: boolean
  /** The form always carries the statement whatever its size (a
   *  bostadsrättsförening, ÅRL 2 kap. 1 §): never withheld, never omitted. */
  required_by_form?: boolean
}

/**
 * One presentation row of the RR/BR in ÅRL uppställningsform. Post-level
 * only - labels must never contain BAS account numbers (Bolagsverket
 * rejects balans-/resultaträkningar med kontonummer). Rows are derived
 * from the K2 risbs mapping in lib/bokslut/arsredovisning/statement-rows.ts.
 */
export interface StatementRow {
  label: string
  /** Stable integrity key for rows whose legal meaning must not depend on the
   * localized presentation label. */
  semantic_key?:
    | 'income_statement_result'
    | 'balance_sheet_current_year_result'
    | 'balance_sheet_forlagsinsatser'
    | 'balance_sheet_share_capital'
    | 'balance_sheet_equity_total'
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

/**
 * ÅRL 6 kap. 3 §: an ekonomisk förening's förvaltningsberättelse must state
 * (1) material changes in the number of members, (2) the sum of insatser to
 * be repaid during the next fiscal year under EFL 10 kap. 11 and 16 §§,
 * (3) the right to distribution that förlagsinsatser carry, and (4) the sum
 * of förlagsinsatser given notice for redemption in the next two fiscal
 * years. Null means unanswered, never "inga": a missing member text blocks
 * filing (completeness AR-EF-MEMBER-INFO), and so does a missing amount
 * (AR-EF-MEMBER-AMOUNTS); an entered 0 prints "inga".
 */
export interface MemberDisclosures {
  member_count_change: string | null
  insatser_repayable_next_year: number | null
  forlagsinsatser_dividend_right: string | null
  forlagsinsatser_redeemable_two_years: number | null
}

export interface ArsredovisningData {
  company: {
    name: string
    org_number: string
    entity_type: string
    /** Företagets säte: company_settings.registered_office, the municipality
     *  the company is registered in (never the postal town). Null when the
     *  company has none stored; completeness then refuses to finalise the
     *  report. Printed on the cover, in förvaltningsberättelsen and on the
     *  underskrifter and fastställelseintyg place lines. */
    registered_office: string | null
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
    id: string
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
    /** The equity posts at year end (kept for versions saved before the
     *  specification; a new report prints `equity_specification`). */
    egen_kapital_changes: EgenKapitalRow[]
    /** Styrelsens förslag till resultatdisposition (manual input). */
    resultatdisposition: string
    proposed_dividend: number
    resultatdisposition_amounts: {
      retained_earnings: number
      share_premium_reserve: number
      /** Server-derived from the statutory statement mapping, never narrative input. */
      current_year_result: number
      total: number
      proposed_dividend: number
      carried_forward: number
    }
    /** ISO date of the årsstämma (or föreningsstämma) where the
     *  årsredovisning was adopted. Populates the fastställelseintyg date
     *  blank. Null means "not yet recorded": PDF then leaves the blank. */
    agm_date: string | null
    /** ÅRL 6 kap. 3 §: the four disclosures an ekonomisk förening must make
     *  in förvaltningsberättelsen. Null for every other legal form. */
    member_disclosures?: MemberDisclosures | null
    /** What the AGM actually decided, distinct from the board's proposal. */
    agm_disposition_outcome: 'proposal_approved' | 'alternative_decision' | null
    agm_disposition_decision: string | null
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
  /** K3-only: the user's choice to leave the kassaflödesanalys out and
   *  whether the law lets this company do so. Set by
   *  buildCanonicalAnnualReport once the size classification is known;
   *  when `omitted` is true, `kassaflodesanalys` is absent. */
  kassaflodesanalys_omission?: CashFlowOmissionState
  /** The specification of changes in equity (ÅRL 6 kap. 2 § andra stycket,
   *  K3 6.3), from the year's equity movements in the ledger: both
   *  frameworks, printed in förvaltningsberättelsen or, when chosen, as a
   *  statement of its own (equity-specification.ts). Absent only on
   *  versions saved before it existed. */
  equity_specification?: EquitySpecification
  /** Versions saved before the specification: the K3 statement derived from
   *  closing balances. No longer produced; the PDF still renders a stored one. */
  equity_changes_statement?: {
    rows: EgenKapitalRow[]
    closing_total: number
  }
  /** K3 only: the förvaltningsberättelse texts the disclosure matrix adds
   *  (K3 3.7 c-g, 3.11, ÅRL 6 kap. 1 §), in document order, printed after
   *  the väsentliga händelser. */
  k3_forvaltningsberattelse?: K3ForvaltningsberattelseItem[]
  /** K3 only: the disclosure matrix evaluated for this report (what each
   *  requirement asks, its status and what the document prints). Set by
   *  buildCanonicalAnnualReport once the size class is known. */
  k3_disclosures?: DisclosureEvaluation[]
  /** K3 only: whether the K3 document is a granskningsutkast or released
   *  (k3-release.ts). Absent on versions saved before the release flag: a
   *  granskningsutkast. */
  k3_release?: 'review_draft' | 'final'
  /** K3 only: whether this is the company's first K3 year (K3 35.3). */
  k3_first_year?: K3FirstYearStatus
  /** Underskrifter: names of board members + VD, and the revisor's slots
   *  (revisor roles, the revisorspåteckning). Filled by signature flow. */
  signatures: {
    role: string
    name: string
    signed_at: string | null
  }[]
  /** The profile's revisorspåteckning facts, read live when a file is
   *  rendered (the revisor gives them after the board signed). Absent on
   *  versions and drafts made before the revisor package. */
  auditor_pateckning?: {
    required: boolean
    firm_name: string | null
    opinion: import('./workflow-schemas').AuditorOpinion | null
  } | null
  /** Pre-download blockers / warnings the UI surfaces so the user knows the
   *  PDF is not yet Bolagsverket-fileable as-is. Examples: aktiekapital
   *  uppgifter saknas, AGM-datum saknas, K3 entity. Never an error: the
   *  user can still download to iterate. */
  warnings: string[]
  /** Faults the build found that make the document wrong as filed (the
   *  anläggningar note not tying to the balansräkning while the register
   *  holds write-downs). Completeness reports each as an error, so the
   *  version cannot be locked. Absent when there is none. */
  errors?: string[]
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
    /** What the registers in Avtal och åtaganden say on the balance date
     *  (lib/commitments): the säkerheter and eventualförpliktelser texts and
     *  the parent company. The fields above override them when filled in
     *  (register-disclosures.ts). Absent when no register has anything, so
     *  the content hash of every other report is unchanged. */
    from_registers?: {
      securities_pledged: string | null
      contingent_liabilities: string | null
      parent_company: { name: string; org_number: string | null; city: string | null } | null
    }
    /** ÅRL 5:20 §: manual medelantal anställda. Null means "computed from
     *  the employees table"; the note and the iXBRL fact already reflect
     *  whichever won. */
    medelantal_anstallda_override: number | null
    /** ÅRL 6 kap. 3 § inputs (ekonomisk förening only; absent for other forms
     *  so their content hash is untouched). */
    member_count_change?: string | null
    insatser_repayable_next_year?: number | null
    forlagsinsatser_dividend_right?: string | null
    forlagsinsatser_redeemable_two_years?: number | null
    /** Persisted choice to leave the K3 kassaflödesanalys out, and the
     *  user's confirmation that the company is not a större företag. Only
     *  honoured when the law permits (cash-flow-omission.ts). */
    omit_kassaflodesanalys: boolean
    kassaflodesanalys_omission_confirmed: boolean
    /** K3 only: the answers to the disclosure matrix, keyed by requirement id. */
    disclosure_answers?: DisclosureAnswers
    /** K3 only: the user's classification of equity verifikat the ledger
     *  cannot classify (journal entry id to kind, K3 6.3). */
    equity_movement_overrides?: Record<string, EquityMovementKind>
    /** K3 only: print the specification of changes in equity as a statement
     *  of its own instead of in förvaltningsberättelsen. */
    equity_statement_separate?: boolean
    confirmations: {
      long_term_debt_over_five_years: boolean
      securities_pledged: boolean
      contingent_liabilities: boolean
      parent_company: boolean
    }
  }
}

/**
 * Kassaflödesanalys carried in ArsredovisningData: the generator's report
 * without fiscal_period_id, which ArsredovisningData.fiscal_period already
 * holds. Derived from KassaflodesanalysReport so the two cannot drift: the K3
 * PDF renders every line the generator produces.
 */
export type KassaflodesAnalysisSummary = Omit<KassaflodesanalysReport, 'fiscal_period_id'>
