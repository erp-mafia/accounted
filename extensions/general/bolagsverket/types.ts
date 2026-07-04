/**
 * DTOs for Bolagsverket's REST services for digital inlämning av
 * årsredovisning, hand-written from Teknisk guide v3.4 (dev_docs/bokslut/
 * GUIDE.md §5 + §8 trafikexempel) and Anslutningsanvisning v1.7.
 *
 * NOTE: the official OpenAPI 2.0 servicespecifikationer are still pending
 * manual download (dev_docs/bokslut/INDEX.md checklist → api/). When they
 * land, reconcile these types against the specs: the specs win on conflict
 * (GUIDE §5.1).
 */

export type BolagsverketEnvironment = 'test' | 'accept' | 'prod'

export type HandlingTyp =
  | 'arsredovisning_komplett'
  | 'arsredovisning'
  | 'revisionsberattelse'

// ---- hamta-arsredovisningsinformation/v1.4 ---------------------------------

export interface GrunduppgifterRakenskapsperiod {
  from: string
  tom: string
  kravPaRevisionsberattelse: 'ja' | 'nej' | 'uppgift_saknas'
  revisorsplikt: 'ja' | 'nej' | 'uppgift_saknas'
}

export interface GrunduppgifterForetradare {
  fornamn: string
  namn: string
  personnummer: string | null
  annanIdentitet: string | null
  funktioner: Array<{ kod: string; text: string }>
}

export interface GrunduppgifterSvar {
  orgnr: string
  lopnummer: number | null
  namn: string
  status: Array<{ kod?: string; text?: string }>
  rakenskapsperioder: GrunduppgifterRakenskapsperiod[]
  foretradare: GrunduppgifterForetradare[]
}

export type ArendestatusTyp =
  | 'arsred_inkommen'
  | 'arsred_forelaggande_skickat'
  | 'arsred_komplettering_inkommen'
  | 'arsred_registrerad'
  | 'arsred_avslutad_ej_registrerad'
  | 'arsred_saknas'

export interface ArendestatusSvar {
  orgnr: string
  namn: string
  hamtat: string
  tidpunkt: string | null
  typ: ArendestatusTyp
  arendenummer: string | null
  rakenskapsperiod: { from: string; tom: string } | null
}

// ---- skapa-inlamningtoken (v2.1) -------------------------------------------

export interface InlamningTokenSvar {
  token: string
  /** MUST be shown to and accepted by the user per company; re-show when
   *  avtalstextAndrad changes (GUIDE §4.2, §5.3.1). */
  avtalstext: string
  avtalstextAndrad: string
}

// ---- kontrollera (v2.1) ----------------------------------------------------

export interface KontrolleraUtfall {
  kod: string
  text: string
  typ: string
  tekniskinformation: Array<{
    meddelande: string | null
    element: string | null
    varde: string | null
  }> | null
}

export interface KontrolleraSvar {
  orgnr: string
  utfall: KontrolleraUtfall[] | null
}

// ---- inlamning (v2.1) ------------------------------------------------------

export interface InlamningBegaran {
  undertecknare: string
  epostadresser: string[]
  kvittensepostadresser?: string[]
  notifieringEpostadresser?: string[]
  handling: { fil: string; typ: HandlingTyp }
}

export interface InlamningSvar {
  orgnr: string
  avsandare: string
  undertecknare: string
  handlingsinfo: {
    typ: HandlingTyp
    dokumentlangd: number
    idnummer: string
    sha256checksumma: string
  }
  url: string
}

// ---- skapa-kontrollsumma (v1.1) --------------------------------------------

export interface KontrollsummaSvar {
  kontrollsumma: string
  algoritm: string
}

// ---- handelser (v2.0) ------------------------------------------------------

export interface HandelseMeddelande {
  typ: string
  /** Orgnr of the company the event concerns. */
  id: string
  /** Per-company sequence number; -1 for the subscription test message. */
  nr: number
  tid: string
  data: {
    version: string
    handlingsinfo?: Array<{
      handling: 'arsredovisning' | 'revisionsberattelse'
      idnummer: string
      kontrollsumma?: { digest: string; algoritm: string; upplysning: string | null } | null
    }>
    status: ArendestatusTyp | 'test'
  }
}

export interface HamtaHandelserSvar {
  meddelanden: HandelseMeddelande[]
}

// ---- submission rows (DB) ---------------------------------------------------

export type SubmissionStatus =
  | 'draft'
  | 'kontrollerad'
  | 'uploaded'
  | 'inkommen'
  | 'forelagd'
  | 'komplettering'
  | 'registrerad'
  | 'avslutad'
  | 'error'

export interface ArsredovisningSubmission {
  id: string
  company_id: string
  user_id: string
  fiscal_period_id: string
  handling_typ: HandlingTyp
  taxonomy_version: string
  entry_point: string
  environment: BolagsverketEnvironment
  status: SubmissionStatus
  undertecknare_namn: string | null
  undertecknare_epost: string | null
  idnummer: string | null
  sha256_checksumma: string | null
  kontrollsumma: string | null
  bolagsverket_url: string | null
  kontrollera_utfall: KontrolleraUtfall[] | null
  dokument_id: string | null
  error_message: string | null
  uploaded_at: string | null
  registered_at: string | null
  created_at: string
  updated_at: string
}
