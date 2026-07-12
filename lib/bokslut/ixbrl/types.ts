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
    /** Formatted with dash, e.g. "556999-9999". */
    orgNumber: string
    /** Säte (city): used in underskrifter and allmänt om verksamheten. */
    city: string | null
  }
  period: { start: string; end: string }
  previousPeriod: { start: string; end: string } | null
  /** True when this is the company's first fiscal year: jämförelsesiffror
   *  may then legitimately be absent (3006/3007 exemption). */
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
  }

  noter: IxbrlNote[]
  /** Medelantal anställda (FTE) for current + previous year. */
  medelantalAnstallda: { current: number; previous: number | null }

  underskrifter: {
    ort: string
    /** Datering av årsredovisning (the day the board fixed the content).
     *  Tagged only for fiscal years beginning 2024-07-01 or later (element
     *  list note on UndertecknandeArsredovisningDatum). */
    dateringsdatum: string | null
    signers: IxbrlSigner[]
    /** True when a VD is among the signers: drives FinansiellRapportList. */
    harVd: boolean
  }

  faststallelseintyg: {
    /** AGM date: must be > räkenskapsårets sista dag (kontrollera 1101).
     *  Null when no AGM date is recorded: the document renders a visible
     *  placeholder instead of a fabricated date and preflight 1103 blocks
     *  filing (Bolagsverket kontrollera 1103 semantics). */
    arsstammaDatum: string | null
    /** The företrädare who will sign at Bolagsverket. */
    signerFirstName: string
    signerLastName: string
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
