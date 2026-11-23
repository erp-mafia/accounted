/**
 * Input model for the iXBRL årsredovisning generator.
 *
 * This is a separate shape from ArsredovisningData (the PDF model) because
 * iXBRL needs concept-keyed amounts for BOTH years (jämförelsesiffror are
 * mandatory: kontrollera codes 3006/3007), while the PDF model carries
 * label-based single-year lines. The mapper (k2-mapper.ts) produces the
 * concept-keyed parts from trial balances; build-input.ts assembles the rest
 * from the same sources the PDF uses.
 */

/** Amounts in whole SEK, oriented to the concept's natural balance:
 *  credit-balance concepts are positive when credit, debit-balance concepts
 *  positive when debit. Negative = deviates from natural sign (`sign="-"`). */
export interface ConceptAmount {
  current: number
  previous: number | null
}

export type ConceptAmounts = Record<string, ConceptAmount>

export interface FlerarsRow {
  /** Label for the column, e.g. "2025". */
  year: string
  nettoomsattning: number
  resultatEfterFinansiellaPoster: number
  /** Percent with one decimal, e.g. 35.5: null when not computable. */
  soliditetPct: number | null
}

export interface EgetKapitalForandring {
  /** IB/UB per tagged column, whole SEK (credit-positive). */
  aktiekapital: { ib: number; ub: number }
  balanseratResultat: { ib: number; ub: number }
  aretsResultat: { ib: number; ub: number }
  totalt: { ib: number; ub: number }
  /** Untagged residual columns (reservfond, överkursfond …), 0 when absent. */
  ovrigaPoster: { ib: number; ub: number }
  /** Movement rows (whole SEK). */
  balanserasINyRakning: number
  utdelning: number
  forandringAktiekapital: number
  /** Balanserat-column residual that is not utdelning/balansering. */
  ovrigForandringBalanserat: number
  aretsResultatRorelse: number
}

export interface Resultatdisposition {
  /** Balanserat resultat ONLY (2090-2096 + 2098): must stay value-identical
   *  to the BalanseratResultat fact in BR/eget kapital (TA §2.7.3). */
  balanseratResultat: number
  /** Fri överkursfond (2097), shown as its own row tagged Overkursfond. */
  overkursfond: number
  aretsResultat: number
  summa: number
  utdelning: number
  balanserasINyRakning: number
  /** Optional styrelsens kommentar (free text from the narrative editor). */
  kommentar: string | null
}

export interface IxbrlNote {
  number: number
  title: string
  body: string
  /**
   * The K2 note on anläggningstillgångar as tables per balance sheet post:
   * the document tags the figures from these instead of printing the body.
   * Absent on every other note and on versions locked before it existed.
   */
  fixedAssets?: import('@/lib/bokslut/arsredovisning/k2-fixed-asset-note').FixedAssetNoteTable[]
}

export interface IxbrlSigner {
  firstName: string
  lastName: string
  /** Visible role label, e.g. "Styrelseledamot", "Verkställande direktör". */
  role: string | null
  /** ISO date for DatumForUndertecknande (per-signer, TA §2.9.1).
   *  Null when the signature request has not been signed yet: the date fact
   *  is then omitted (never fabricated) and preflight 1214 blocks filing. */
  signedDate: string | null
}

export interface IxbrlArsredovisningInput {
  company: {
    name: string
    /** As stored in the company settings ("5569999997" or "556999-9997"):
     *  the generator writes it as NNNNNN-NNNN everywhere. */
    orgNumber: string
    /** Säte (company_settings.registered_office, never the postal town):
     *  tagged ForetagetsSate on the cover and used as ort in underskrifter. */
    registeredOffice: string | null
  }
  period: { start: string; end: string }
  previousPeriod: { start: string; end: string } | null
  /** True when this is the company's first fiscal year (isFirstFiscalPeriod):
   *  jämförelsesiffror may then legitimately be absent (3006/3007 exemption). */
  isFirstFiscalYear: boolean

  /** RR concept-keyed amounts (kostnadsslagsindelad, risbs posts). */
  rr: ConceptAmounts
  /** BR concept-keyed amounts (risbs posts). */
  br: ConceptAmounts
  /** Computed subtotals/totals from the mapper (same orientation rules). */
  totals: import('./k2-mapper').K2MappingResult['totals']

  forvaltningsberattelse: {
    allmantOmVerksamheten: string
    vasentligaHandelser: string
    flerarsoversikt: FlerarsRow[]
    /** Period ranges aligned 1:1 with flerarsoversikt rows (newest first).
     *  Index 0/1 reuse period0/period1; 2/3 get their own contexts. */
    flerarsPerioder: Array<{ start: string; end: string }>
    egetKapital: EgetKapitalForandring
    resultatdisposition: Resultatdisposition
    /** The PDF's "Kontrollbalansräkning har upprättats …" statement (ABL 25
     *  kap.). Optional: versions locked before it existed lack the key. */
    kontrollbalansrakningUpprattad?: boolean
  }

  noter: IxbrlNote[]
  disclosures: {
    longTermDebtOverFiveYears: number
    securitiesPledged: string
    contingentLiabilities: string
    parentCompany: string | null
    /** Registered share capital behind the Aktiekapital note (ÅRL 5 kap.
     *  14 §), so its amount can be tagged. Present when that note is;
     *  optional for versions locked before it existed. */
    aktiekapitalNot?: { aktiekapital: number; antalAktier: number } | null
  }
  /** Medelantal anställda (FTE) for current + previous year. */
  medelantalAnstallda: { current: number; previous: number | null }

  underskrifter: {
    ort: string
    /** Datering av årsredovisning (the day the board fixed the content):
     *  the earliest signature date, see arsredovisningDatering(). Tagged
     *  only for fiscal years beginning 2024-07-01 or later (element list
     *  note on UndertecknandeArsredovisningDatum). */
    dateringsdatum: string | null
    signers: IxbrlSigner[]
    /** True when a VD is among the signers: drives FinansiellRapportList. */
    harVd: boolean
  }

  /**
   * The revisor's hänvisning to the revisionsberättelse (ABL 9 kap. 28 §),
   * read live from the roster's revisor slots and the profile, like the
   * signatures: the revisor gives it after the board signed. Null or absent
   * when no revisionsberättelse is required and no revisor is in the roster;
   * optional for versions locked before it existed.
   */
  revisorspateckning?: import('./revisorspateckning').IxbrlRevisorspateckning | null

  /**
   * What only the K3 document carries: the förvaltningsberättelse texts K3
   * asks for beyond verksamheten and väsentliga händelser, the specification
   * of changes in equity per post (fscie concepts) and the kassaflödesanalys
   * (fcf concepts). Present exactly when entryPointId is a K3 entry point.
   */
  k3?: K3IxbrlInput

  faststallelseintyg: {
    /** AGM date: must be > räkenskapsårets sista dag (kontrollera 1101).
     *  Null when no AGM date is recorded: the document renders a visible
     *  placeholder instead of a fabricated date and preflight 1103 blocks
     *  filing (Bolagsverket kontrollera 1103 semantics). */
    arsstammaDatum: string | null
    resultatdispositionOutcome: 'proposal_approved' | 'alternative_decision' | null
    resultatdispositionDecision: string | null
    /** The företrädare who will sign at Bolagsverket. */
    signerFirstName: string
    signerLastName: string
    /** Roster role ("Styrelseordförande", "VD", …); written into the
     *  document in the taxonomy's vocabulary by certificateRole(). */
    signerRole: string
    /** Document generation date: Bolagsverket overwrites at actual signing
     *  (TA §4.4: set today's date). */
    genereratDatum: string
  }

  /** TA §4.3 head metadata. Name standard "<leverantör> - <produkt>". */
  programvara: { namn: string; version: string }

  /** Entry point id resolved via getEntryPoint (taxonomy version is data). */
  entryPointId: string

  /** Non-blocking issues collected while building (unmapped accounts etc.). */
  warnings: string[]
}

// ---- K3 ------------------------------------------------------------------

/**
 * One equity post of the specification of changes in equity (ÅRL 6 kap. 2 §
 * andra stycket, K3 6.3 a-e), whole SEK, credit-positive: an increase of the
 * post is > 0. `concept` is the post's balance sheet concept.
 */
export interface K3EquityPost {
  concept: string
  label: string
  bound: boolean
  opening: number
  closing: number
  /** Movement kind (the equity specification's keys) → amount. */
  movements: Record<string, number>
}

export interface K3EquityInput {
  /**
   * 'ledger': the year's real equity movements (the equity specification
   * built from the 20xx verifikat). 'closing_balances': derived from the
   * balances when no specification exists; preflight refuses to file it.
   */
  source: 'ledger' | 'closing_balances'
  /** Movement kinds in presentation order, with their row labels. */
  kinds: Array<{ kind: string; label: string }>
  /** The räkenskapsår's posts. */
  posts: K3EquityPost[]
  /**
   * Where the årsredovisning shows it (K3 3.10 allows both): in the
   * förvaltningsberättelse (the year only) or as a statement of its own
   * after the kassaflödesanalys (with the jämförelseår in `previous`).
   */
  placement: 'management_report' | 'separate_statement'
  /** The jämförelseår's posts, when the specification could read that year. */
  previous: K3EquityPost[] | null
}

/** A kassaflödesanalys row (K3 chapter 7 layout), signed cash effect in whole SEK. */
export interface K3CashFlowRow {
  key: string
  section: 'lopande' | 'investering' | 'finansiering' | 'likvida_medel'
  label: string
  /** fcf concept, or null for a row the taxonomy has none for (untagged). */
  concept: string | null
  kind: 'line' | 'subtotal' | 'total'
  current: number
  previous: number | null
  alwaysShow: boolean
  /** LikvidaMedel is an instant concept: the balance at the year's start or end. */
  instant?: 'start' | 'end'
}

export interface K3CashFlowInput {
  /**
   * 'chapter7': the K3 chapter 7 statement (gross investing and financing
   * flows, interest and dividends apart). 'summary': the older summary
   * report; preflight refuses to file it.
   */
  source: 'chapter7' | 'summary'
  rows: K3CashFlowRow[]
  /** The statement's own reconciliation of årets kassaflöde to likvida medel. */
  reconciled: boolean
}

export interface K3IxbrlInput {
  /** Förvaltningsberättelse texts beyond verksamheten and väsentliga händelser, by fdr concept. */
  forvaltningsberattelse: Array<{ concept: string | null; heading: string; text: string }>
  equity: K3EquityInput
  /** Null when the kassaflödesanalys is left out (mindre företag, ÅRL 2 kap. 1 §). */
  cashFlow: K3CashFlowInput | null
  /** Where the K3 balance sheet posts came from: 'k3_presentation' carries K3's own posts. */
  balanceSheetSource: 'k3_presentation' | 'k2_mapping'
}
