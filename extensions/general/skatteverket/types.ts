/**
 * Skatteverket API types for Momsdeklaration 1.0
 *
 * Field names match Skatteverket's JSON schema exactly.
 * Reference: Tjänstebeskrivning Momsdeklaration v1.5
 */

/** Momsuppgift payload: maps 1:1 to SKV 4700 boxes */
export interface SkatteverketMomsuppgift {
  momspliktigForsaljning?: number       // Box 05
  momspliktigaUttag?: number            // Box 06
  vinstmarginal?: number                // Box 07
  hyresInkomst?: number                 // Box 08
  momsForsaljningUtgaendeHog?: number   // Box 10
  momsForsaljningUtgaendeMedel?: number // Box 11
  momsForsaljningUtgaendeLag?: number   // Box 12
  inkopVarorEU?: number                 // Box 20
  inkopTjansterEU?: number              // Box 21
  inkopTjansterUtanforEU?: number       // Box 22
  inkopVarorSE?: number                 // Box 23
  inkopTjansterSE?: number              // Box 24
  momsInkopUtgaendeHog?: number         // Box 30
  momsInkopUtgaendeMedel?: number       // Box 31
  momsInkopUtgaendeLag?: number         // Box 32
  forsaljningVarorEU?: number           // Box 35
  forsaljningVarorUtanforEU?: number    // Box 36
  inkopVaror3pHandel?: number           // Box 37
  forsaljningVaror3pHandel?: number     // Box 38
  forsaljningTjansterEU?: number        // Box 39
  ovrigForsaljningTjansterUtanforSE?: number // Box 40
  forsaljningBskKopareSE?: number       // Box 41
  momsfriForsaljning?: number           // Box 42
  ingaendeMomsAvdrag?: number           // Box 48
  summaMoms?: number                    // Box 49
  import?: number                       // Box 50
  momsImportUtgaendeHog?: number        // Box 60
  momsImportUtgaendeMedel?: number      // Box 61
  momsImportUtgaendeLag?: number        // Box 62
}

/**
 * Validation result from Skatteverket /kontrollera or /utkast.
 * Field names match Momsdeklaration v1.0.24 RAML: note SKV's mixed casing
 * on `kontrollResultat` and `signeringsLank`.
 */
export interface SkatteverketKontrollResultat {
  status?: 'OK' | 'WARNING' | 'ERROR'
  resultat?: SkatteverketKontroll[]
}

export interface SkatteverketKontroll {
  kod: string             // e.g. "49"
  status: 'ERROR' | 'WARNING'
  beskrivning: string
}

/** Response from saving a draft */
export interface SkatteverketUtkastResponse {
  kontrollResultat?: SkatteverketKontrollResultat
  signeringsLank?: string
  locked?: boolean
}

/** Response from fetching submitted declarations */
export interface SkatteverketInlamnatResponse {
  kvittensnummer?: string
  tidpunkt?: string    // ISO 8601 timestamp
  signerare?: string   // Personnummer of signer
}

/** Response from fetching decisions */
export interface SkatteverketBeslutatResponse {
  beslutsdatum?: string
  momsBeslut?: SkatteverketMomsuppgift
}

/** Stored token pair (decrypted form) */
export interface SkatteverketTokens {
  access_token: string
  refresh_token: string | null
  expires_at: number     // Unix timestamp ms
  refresh_count: number
  scope: string
}

/** Declaration submission status tracking */
export type DeclarationStatus =
  | 'draft_saved'
  | 'draft_locked'
  | 'signed'
  | 'decided'

// ── AGI (Arbetsgivardeklaration) types ──────────────────────────
//
// Field shapes mirror the Skatteverket RAMLs in dev_docs/:
//   • arbetsgivardeklaration-inlamning(1.7.7)             (XML ingest + JSON status)
//   • arbetsgivardeklaration-hantera-redovisningsperiod(1.2.8) (period management)
//
// AGI submission is XML, not JSON. The XML body posted to /underlag is built
// by lib/salary/agi/xml-generator.ts and stored in agi_declarations.xml_content.
// The types below describe only the JSON responses the extension reads back.

/**
 * Response from POST /underlag: Skatteverket assigns an inlämningsId we
 * then use to poll kontrollresultat and to spara/avbryta.
 */
export interface SkatteverketAGIUnderlagResponse {
  inlamningId: number
}

/**
 * Response from GET /underlag/{inlamningId}/kontrollresultat.
 * Status flow: PROCESSING → DONE_SUCCESS | DONE_FAILED | DONE_REJECTED.
 *
 * DONE_SUCCESS : XML accepted, no stop-errors. Caller may proceed to spara.
 * DONE_REJECTED: stoppande fel; caller can spara to keep it in Eget utrymme
 *                 for the user to fix in Mina Sidor, or DELETE /underlag/{id}.
 * DONE_FAILED  : system failure; nothing was saved.
 */
export interface SkatteverketAGIKontrollresultat {
  status: 'PROCESSING' | 'DONE_SUCCESS' | 'DONE_FAILED' | 'DONE_REJECTED'
  inlamnad: string                  // ISO timestamp
  antalUppgifter: number
  kontrolleradeUppgifter: number
  kontrollrapport?: SkatteverketAGIKontrollrapport
}

export interface SkatteverketAGIKontrollrapport {
  filstorlek: number
  filnamn: string
  inkanal: 'MASK' | 'eFIL' | 'eMAN'
  status: 'OK' | 'AKTUALITET_OK' | 'WARNING' | 'FAILED'
  totaltAntalHU?: number
  totaltAntalIU?: number
  antalFel?: number
  antalVarningar?: number
  bearbetningsfel: SkatteverketAGIFel[]
  valideringsfel: SkatteverketAGIFel[]
  redovisningsperioder: SkatteverketAGIPeriodFel[]
}

export interface SkatteverketAGIFel {
  felmeddelande: string
  mid?: string
  arbetsgivare?: string
}

export interface SkatteverketAGIPeriodFel {
  arbetsgivare: string
  perioder: Array<{
    period: string                  // YYYYMM
    antalIU: number
    antalHU: number
    antalFel: number
    antalVarningar: number
    kontrollfel: SkatteverketAGIKontrollfel[]
  }>
}

export interface SkatteverketAGIKontrollfel {
  felkategori: string
  uppgiftsTyp: string               // 'HU' | 'IU' | 'FU'
  textNyckel: string
  textTyp: string
  identifierare?: string            // pnr/orgnr the rule fired on
  specifikationsnummer?: number
  felmeddelande: string
  felstatus: 'STOPP' | 'ARENDE'
}

/**
 * Response from POST /arbetsgivare/{x}/redovisningsperioder/{y}/skapaGranskningsunderlag.
 * `link` is a Mina Sidor deep-link the user opens to sign with BankID.
 */
export interface SkatteverketAGIGranskningsunderlagResponse {
  link: string
  tillstand: 'LOCKED_FOR_SIGNING' | 'UNLOCKED' | 'INCORRECT_DATA' | 'RECEIVING' | 'CALCULATING'
  meddelande: string
}

/**
 * Response from GET /arbetsgivare/{x}/redovisningsperioder/{y}/kvittenser.
 * Empty array until the user has signed in Mina Sidor.
 */
export interface SkatteverketAGIKvittenserResponse {
  kvittenser: SkatteverketAGIKvittens[]
}

export interface SkatteverketAGIKvittens {
  arbetsgivare: string              // SSÅÅMMDDNNNK
  period: string                    // YYYYMM
  uuidKvittens?: string
  signeradAv?: string
  signeradTid?: string              // ISO timestamp
  underlag: {
    arbetsgivarregistrerad: string
    redovisningsperiod: string
    antalIu: number
    antalIuTillagda: number
    antalIuBorttagna: number
    omprovningSanktSkatteavdrIU?: string
    errorMessage?: string
  }
}

/**
 * Standard error envelope for both AGI APIs (HTTP 400/404/409/etc).
 * Distinct from the moms felkod envelope.
 */
export interface SkatteverketAGIErrorBody {
  kod: number
  meddelandeTillAnvandare: string
  meddelandeTillUtvecklare?: string
}

/**
 * Response from POST /underlag/huvuduppgift/kontrollera and
 * /underlag/individuppgift/kontrollera (Skatteverket v1.7 §6.6 kontrollsvar).
 *
 * Validates a single HU or IU as JSON without storing it. `fel` is empty
 * when status === 'OK'. AVVISANDE means the payload was malformed enough
 * to skip rule evaluation; STOPP is a hard validation failure that would
 * reject the underlag.
 */
export interface SkatteverketAGIKontrollsvar {
  status: 'OK' | 'INFO' | 'ARENDE' | 'STOPP' | 'AVVISANDE'
  fel: SkatteverketAGIKontrollsvarFel[]
}

export interface SkatteverketAGIKontrollsvarFel {
  status: 'OK' | 'INFO' | 'ARENDE' | 'STOPP' | 'AVVISANDE'
  felmeddelande?: string
}

export interface SkatteverketSubmission {
  id: string
  user_id: string
  redovisare: string         // 12-digit org/personnummer
  redovisningsperiod: string // YYYYMM
  status: DeclarationStatus
  kvittensnummer: string | null
  signeringslank: string | null
  kontrollresultat: SkatteverketKontrollResultat | null
  momsuppgift: SkatteverketMomsuppgift
  created_at: string
  updated_at: string
}

// ── Skattekonto (tax account) types ────────────────────────────
//
// Field names match Skatteverket's Skattekonto API v2.1.0 JSON schema.
// Spec: dev_docs/skattekonto(2.1.0)/skattekonto-extern.raml
// Amount fields are in SEK (whole or decimal); negative = debt to SKV.

/** Response from GET /skattekonton/{omfragad}/saldo */
export interface SkatteverketSaldoResponse {
  /** Next reconciliation date (YYYY-MM-DD) */
  nastaAvstamningsdatum: string
  /** Last update timestamp (ISO 8601) */
  senastUppdaterad: string
  /** Free-text info messages (max 200 chars each) */
  informationstext: string[]
  /** Current balance at Skatteverket (negative = debt) */
  saldoSkatteverket: number
  /** Balance moved to Kronofogden (negative = enforcement debt) */
  saldoKronofogden: number
  /** Preliminary interest accrued at Skatteverket */
  rantaSkatteverket: number
  /** Preliminary interest accrued at Kronofogden */
  rantaKronofogden: number
  /** OCR reference for paying the balance */
  ocrNummer: string
}

/** Booked transaction (tidigareTransaktioner) */
export interface SkatteverketBookedTransaction {
  /** Stable identity from Skatteverket: primary dedup key */
  transaktionsidentitet: number
  /** Booking date (YYYY-MM-DD) */
  transaktionsdatum: string
  /** Interest calculation date (YYYY-MM-DD) */
  ranteberakningsdatum: string | null
  /** Description (e.g. "Inbetalning bokförd 190412") */
  transaktionstext: string
  /** Amount at Skatteverket (positive = credit, negative = debit) */
  beloppSkatteverket: number
  /** Amount moved to Kronofogden (rare) */
  beloppKronofogden: number | null
}

/** Future / scheduled transaction (kommandeTransaktioner) */
export interface SkatteverketUpcomingTransaction {
  /** Posting date (YYYY-MM-DD) */
  transaktionsdatum: string
  /** Due date for payment (YYYY-MM-DD) */
  forfallodatum: string
  /** Interest calculation date (YYYY-MM-DD) */
  ranteberakningsdatum: string | null
  /** Description */
  transaktionstext: string
  /** Amount at Skatteverket */
  beloppSkatteverket: number
  /** Amount at Kronofogden */
  beloppKronofogden: number | null
  /** Often null on kommande: fall back to dedup_key */
  transaktionsidentitet: number | null
}

/** Response from GET /skattekonton/{omfragad}/transaktioner */
export interface SkatteverketTransaktionerResponse {
  tidigareTransaktioner: SkatteverketBookedTransaction[]
  kommandeTransaktioner: SkatteverketUpcomingTransaction[]
}

/** Skatteverket error envelope (felkod 1-5) */
export interface SkatteverketFel {
  felkod: number
  felmeddelande: string
}

// Re-exported from core because the table lives in core migrations and
// the /transactions page (core) needs to render its rows. Extension-internal
// code continues to import from this module for backwards compatibility.
export type {
  StoredSkattekontoTransaction,
  SkattekontoMatchSuggestion,
  SkattekontoTransactionWithSuggestion,
} from '@/types/skatteverket'

/** Cached snapshot stored in extension_data under key skattekonto_balance_snapshot */
export interface SkattekontoBalanceSnapshot {
  saldo: SkatteverketSaldoResponse
  /** Unix ms when this snapshot was fetched from Skatteverket */
  fetchedAt: number
}
