import { maskPersonnummerInText } from '@/lib/salary/personnummer-format'
import type {
  SkatteverketAGIFel,
  SkatteverketAGIKontrollresultat,
} from '../types'

/** At most this many messages per list: a malformed file can carry thousands. */
const MAX_MESSAGES = 50

export interface AgiKontrollrapportSummary {
  /** The kontrollresultat status (DONE_REJECTED / DONE_FAILED). */
  kontrollresultat_status: SkatteverketAGIKontrollresultat['status']
  status: string | null
  antalFel: number | null
  antalVarningar: number | null
  valideringsfel: Array<{ felmeddelande: string; mid?: string }>
  bearbetningsfel: Array<{ felmeddelande: string; mid?: string }>
  redovisningsperioder: Array<{
    period: string
    antalFel: number
    antalVarningar: number
    kontrollfel: Array<{
      felkategori: string
      uppgiftsTyp: string
      textNyckel: string
      specifikationsnummer?: number
      identifierare?: string
      felmeddelande: string
      felstatus: string
    }>
  }>
  /** True when any list above was cut at MAX_MESSAGES. */
  truncated: boolean
}

function felList(list: SkatteverketAGIFel[] | undefined, cut: { truncated: boolean }) {
  const all = list ?? []
  if (all.length > MAX_MESSAGES) cut.truncated = true
  return all.slice(0, MAX_MESSAGES).map((f) => ({
    felmeddelande: maskPersonnummerInText(f.felmeddelande ?? ''),
    ...(f.mid ? { mid: f.mid } : {}),
  }))
}

/**
 * Skatteverket's kontrollsvar for a rejected AGI underlag, reduced to what a
 * user or agent needs to fix the declaration: the overall status, the error
 * counts and every felmeddelande per fältkod/specifikationsnummer. Every
 * personnummer in it is masked (YYYYMMDD-XXXX); the employer id is dropped
 * (it is the company's own). Null when Skatteverket sent no kontrollrapport.
 */
export function summarizeAgiKontrollrapport(
  kontroll: SkatteverketAGIKontrollresultat,
): AgiKontrollrapportSummary | null {
  const rapport = kontroll.kontrollrapport
  if (!rapport) return null
  const cut = { truncated: false }
  const redovisningsperioder = (rapport.redovisningsperioder ?? []).flatMap((ag) =>
    (ag.perioder ?? []).map((p) => {
      const kontrollfel = p.kontrollfel ?? []
      if (kontrollfel.length > MAX_MESSAGES) cut.truncated = true
      return {
        period: p.period,
        antalFel: p.antalFel,
        antalVarningar: p.antalVarningar,
        kontrollfel: kontrollfel.slice(0, MAX_MESSAGES).map((k) => ({
          felkategori: k.felkategori,
          uppgiftsTyp: k.uppgiftsTyp,
          textNyckel: k.textNyckel,
          ...(k.specifikationsnummer !== undefined ? { specifikationsnummer: k.specifikationsnummer } : {}),
          ...(k.identifierare ? { identifierare: maskPersonnummerInText(k.identifierare) } : {}),
          felmeddelande: maskPersonnummerInText(k.felmeddelande ?? ''),
          felstatus: k.felstatus,
        })),
      }
    }),
  )
  return {
    kontrollresultat_status: kontroll.status,
    status: rapport.status ?? null,
    antalFel: rapport.antalFel ?? null,
    antalVarningar: rapport.antalVarningar ?? null,
    valideringsfel: felList(rapport.valideringsfel, cut),
    bearbetningsfel: felList(rapport.bearbetningsfel, cut),
    redovisningsperioder,
    truncated: cut.truncated,
  }
}

/** The first error message in the summary, for a one-line refusal text. */
export function firstAgiKontrollMessage(summary: AgiKontrollrapportSummary | null): string | null {
  if (!summary) return null
  return (
    summary.valideringsfel[0]?.felmeddelande ||
    summary.bearbetningsfel[0]?.felmeddelande ||
    summary.redovisningsperioder.flatMap((p) => p.kontrollfel)[0]?.felmeddelande ||
    null
  )
}
