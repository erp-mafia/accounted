/**
 * What the PDF's Underskrifter and Fastställelseintyg pages print, shared by
 * the K2 and K3 templates.
 *
 * Two renders (crm#1171, crm#1172):
 *   - 'signing': a version locked for signature (or signed, filed,
 *     registered). This is the copy the board prints and signs, so the
 *     blank lines stay: they are meant to be filled in by hand.
 *   - 'draft': the live preview and every versionsutkast. Nobody signs a
 *     draft, so blank signature and date lines would only look like a form
 *     to fill in. They are left out and a short note says what goes there
 *     and when; anything already known (signer names, dates, the AGM) is
 *     printed.
 *
 * What the pages must contain (.claude/skills/swedish-financial-reporting):
 *   - Underskrifter, ÅRL 2 kap. 7 §: every styrelseledamot and the VD sign;
 *     for räkenskapsår starting 2024-07-01 or later each signer states the
 *     date of their signature (references/arsredovisning-structure.md § 6).
 *   - Fastställelseintyg: the certificate that the income statement and the
 *     balance sheet were adopted at the årsstämma, with the date and the
 *     resolution on the result; it is filed with the årsredovisning
 *     (references/bolagsverket-filing.md § 1, ÅRL 8 kap. 3 §).
 */
import { todayIsoStockholm } from '@/lib/dates/iso'
import { ISO_DATE_RE } from '@/lib/invariants'

export type ArsredovisningPdfMode = 'draft' | 'signing'

const SIGNING_STATUSES = new Set(['ready_for_signature', 'signed', 'filed', 'registered'])

/**
 * The render a stored version gets. The live preview (no version) and draft
 * or superseded versions are drafts: none of them is the copy to sign.
 */
export function pdfModeForVersionStatus(status: string | null | undefined): ArsredovisningPdfMode {
  return status && SIGNING_STATUSES.has(status) ? 'signing' : 'draft'
}

/**
 * The day a signature was given (YYYY-MM-DD), null while unsigned. signed_at
 * is an instant: a signature recorded at 00:30 in Stockholm is still the day
 * before in UTC, so the Swedish calendar day is read from it, never the first
 * ten characters of the UTC string. One definition for the PDF and every
 * iXBRL path; a plain YYYY-MM-DD passes through unchanged.
 */
export function signatureDate(signedAt: string | null | undefined): string | null {
  if (!signedAt) return null
  if (ISO_DATE_RE.test(signedAt)) return signedAt
  const instant = new Date(signedAt)
  return Number.isNaN(instant.getTime()) ? signedAt.slice(0, 10) : todayIsoStockholm(instant)
}

export const DRAFT_SIGNATURES_NOTE =
  'Utkast. Årsredovisningen skrivs under av samtliga styrelseledamöter och eventuell VD, ' +
  'och var och en anger datum för sin underskrift (ÅRL 2 kap. 7 §). ' +
  'Raderna för underskrift och datum kommer med i den version som låses för underskrift.'

export const DRAFT_NO_SIGNERS = 'Inga undertecknare är registrerade ännu.'

/**
 * Who signs the fastställelseintyg: a styrelseledamot or the verkställande
 * direktör (founder decision 2026-10-15, following the skill's
 * references/bolagsverket-filing.md § 5; the intyg is filed under ÅRL 8 kap.
 * 3 §). The same rule as CERTIFICATE_SIGNER_ROLES in workflow-schemas.ts.
 */
export const CERTIFICATE_SIGNER = 'styrelseledamot eller verkställande direktör'
export const CERTIFICATE_SIGNER_LINE = 'Styrelseledamot eller verkställande direktör (närvarande vid stämman)'

/** @param meeting "årsstämman" or, for an ekonomisk förening, "föreningsstämman". */
export function draftCertificateNote(meeting: string): string {
  return (
    `Utkast. Fastställelseintyget fylls i efter ${meeting}: det intygar att resultaträkningen ` +
    `och balansräkningen har fastställts, med datum för stämman och stämmans beslut om ` +
    `resultatdisposition, skrivs under av en ${CERTIFICATE_SIGNER} och lämnas till ` +
    `Bolagsverket tillsammans med årsredovisningen (ÅRL 8 kap. 3 §).`
  )
}
