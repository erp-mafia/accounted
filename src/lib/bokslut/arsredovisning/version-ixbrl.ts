import type { SupabaseClient } from '@supabase/supabase-js'
import type { IxbrlArsredovisningInput } from '@/lib/bokslut/ixbrl/types'
import { withoutAgmWarnings, withoutSignatureWarnings } from '@/lib/bokslut/ixbrl/input-warnings'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { arsredovisningDatering } from './datering'
import { getAgmDecision } from './narrative-service'
import { getAnnualReportProfile } from './profile-service'
import { buildRevisorspateckning, splitRoster, versionPateckningFacts } from '@/lib/bokslut/ixbrl/revisorspateckning'
import { signatureDate } from './signature-pages'
import { getAnnualReportVersion } from './version-service'

/** Version states in which every required signature has been given. */
const FULLY_SIGNED_STATUSES = new Set(['signed', 'filed', 'registered'])

/** A version-bound signature row as the signature flow stores it. */
export interface VersionSignatureRow {
  signer_name: string
  role: string
  signed_at: string | null
  /** The påteckning frozen on a signed revisor slot; null on every other row. */
  pateckning_opinion?: string | null
  pateckning_firm_name?: string | null
}

/**
 * Put a locked version's signatures into its frozen iXBRL input. Signatures
 * are stored apart from the content snapshot because they are given after
 * the version is locked. Shared by the download and the submission path so
 * both produce the same document. `complete` says every required signature
 * is in (the version is signed): the "not signed yet" warnings frozen at the
 * lock no longer apply.
 */
export function overlayVersionSignatures(
  input: IxbrlArsredovisningInput,
  rows: VersionSignatureRow[],
  options: { complete: boolean },
): void {
  // The revisor's slots carry the revisorspåteckning, not a board signature
  // (ABL 9 kap. 28 §): overlayRevisorspateckning reads them instead.
  const { board } = splitRoster(rows)
  input.underskrifter.signers = board.map((signature) => {
    const parts = signature.signer_name.trim().split(/\s+/)
    return {
      firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0],
      lastName: parts.length > 1 ? parts.at(-1) ?? parts[0] : parts[0],
      role: signature.role,
      signedDate: signatureDate(signature.signed_at),
    }
  })
  input.underskrifter.harVd = input.underskrifter.signers.some((signer) =>
    /verkställande direktör|^vd$/i.test(signer.role ?? ''),
  )
  input.underskrifter.dateringsdatum = arsredovisningDatering(
    input.underskrifter.signers.map((signer) => signer.signedDate),
  )
  if (options.complete) input.warnings = withoutSignatureWarnings(input.warnings)
}

/**
 * The revisorspåteckning is given after the board signed, so the version's
 * content did not freeze it at lock time: the version's revisor slots
 * (`rows`, the same version-bound rows overlayVersionSignatures reads) are
 * put on top, with the opinion and revisionsbolag frozen on them when the
 * påteckning was given (versionPateckningFacts; the profile only while a
 * revisor slot is pending). Whether a revisionsberättelse is required is read
 * from the profile: it renders nothing without a revisor slot, but a required
 * one with no slot then fails preflight instead of filing without one.
 */
export async function overlayRevisorspateckning(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  input: IxbrlArsredovisningInput,
  rows: VersionSignatureRow[],
): Promise<void> {
  const profile = await getAnnualReportProfile(supabase, companyId, fiscalPeriodId)
  const facts = versionPateckningFacts(rows, profile)
  input.revisorspateckning = buildRevisorspateckning(splitRoster(rows).revisorer, {
    auditor_report_required: profile.auditor_report_required,
    auditor_firm_name: facts?.firmName ?? null,
    auditor_opinion: facts?.opinion ?? null,
  })
}

/**
 * The fastställelseintyg is not part of the signed content: the årsstämma
 * adopts the statements after the board has signed, and the app asks for the
 * AGM date and decision after signing. A version froze the intyg as it stood
 * at lock time, so the AGM recorded since then is read from the narrative and
 * put on top, and the intyg is dated today (TA §4.4.1: Bolagsverket replaces
 * the date when the intyg is signed; a lock-time date would precede the AGM,
 * kontrollkod 1165).
 */
export async function overlayFaststallelseintyg(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  input: IxbrlArsredovisningInput,
  todayIso: string = todayIsoStockholm(),
): Promise<void> {
  const agm = await getAgmDecision(supabase, companyId, fiscalPeriodId)
  if (agm?.agm_date) input.faststallelseintyg.arsstammaDatum = agm.agm_date
  if (agm?.agm_disposition_outcome) {
    input.faststallelseintyg.resultatdispositionOutcome = agm.agm_disposition_outcome
    input.faststallelseintyg.resultatdispositionDecision = agm.agm_disposition_decision
  }
  input.faststallelseintyg.genereratDatum = todayIso
  input.warnings = withoutAgmWarnings(input.warnings, {
    date: input.faststallelseintyg.arsstammaDatum !== null,
    decision: input.faststallelseintyg.resultatdispositionOutcome !== null,
  })
}

/** Load immutable version data and overlay what is recorded after the lock. */
export async function getVersionIxbrlInput(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  versionId: string,
): Promise<IxbrlArsredovisningInput | null> {
  const version = await getAnnualReportVersion(supabase, companyId, fiscalPeriodId, versionId)
  if (!version?.ixbrl_data) return null
  const input = structuredClone(version.ixbrl_data)
  const { data, error } = await supabase
    .from('arsredovisning_signature_requests')
    .select('signer_name, role, signed_at, pateckning_opinion, pateckning_firm_name')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('annual_report_version_id', versionId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to load version signatures: ${error.message}`)
  const rows = (data ?? []) as VersionSignatureRow[]
  if (rows.length > 0) {
    overlayVersionSignatures(input, rows, { complete: FULLY_SIGNED_STATUSES.has(version.summary.status) })
  }
  await overlayFaststallelseintyg(supabase, companyId, fiscalPeriodId, input)
  await overlayRevisorspateckning(supabase, companyId, fiscalPeriodId, input, rows)
  return input
}
