/**
 * Nordea's file service for pain.001: the Signer ID it identifies the sender
 * of a file by, defined once for the supplier, tax-account and salary files
 * and for Settings (crm#1530).
 *
 * Source: Nordea "Corporate Access Payables, Message Implementation
 * Guidelines pain.001.001.09", MIG version 1.4 (2026-09-16), and "Corporate
 * eGateway, Message Implementation Guideline pain.001.001.03", MIG version
 * 3.3 (2026-09-16), both on nordea.com. GrpHdr/InitgPty/Id/OrgId/Othr/Id is
 * "CUST: Customer identification, i.e. "Signer Id" as agreed with (or
 * assigned by) Nordea", with SchmeNm/Cd CUST required. Nordea's file upload
 * checks it against the file agreement and refuses any other id ("Filen
 * avvisades - fel Signer ID ... Ditt Signer ID är NB...").
 */

import { settingsBankBic } from '@/lib/payments/bank-account'

export const NORDEA_BIC = 'NDEASESS'

/**
 * Whether a BIC names Nordea, read as its bank part: whitespace removed,
 * upper case, first 8 characters, so 'ndeasess' and 'NDEASESSXXX' match.
 */
export function isNordeaBic(bic: string | null | undefined): boolean {
  return (bic ?? '').replace(/\s/g, '').toUpperCase().slice(0, 8) === NORDEA_BIC
}

/** Whether the company's bank resolves to Nordea by the chain the payment files use (settingsBankBic). */
export function isNordeaCompany(settings: Parameters<typeof settingsBankBic>[0]): boolean {
  return isNordeaBic(settingsBankBic(settings))
}

/**
 * The MIG gives "max. 13 digits", but Nordea's own upload names ids of the
 * form NB followed by 11 digits (crm#1530), so letters are allowed up to the
 * Max35Text the schema takes.
 * Stored normalised: spaces and hyphens removed, upper case.
 */
export const NORDEA_SIGNER_ID_PATTERN = /^[A-Z0-9]{1,35}$/

/**
 * Why a Nordea debtor's pain.001 cannot be made, in Swedish: Nordea refuses a
 * file whose Signer ID is not the one in the file agreement.
 */
export const NORDEA_SIGNER_ID_MISSING_SV =
  'Nordea kräver företagets Signer ID i betalfilen. Du får det av Nordea, och Nordea visar det också när en fil avvisas för fel Signer ID. Fyll i det under Inställningar → Fakturor.'

export type NordeaSignerIdResolution = { ok: true; signerId: string | null } | { ok: false }

/**
 * The Signer ID a payment file for this debtor carries: null for every other
 * bank, the stored id for Nordea, or not ok when the debtor is Nordea and no
 * id is stored, because Nordea refuses such a file at upload.
 */
export function resolveNordeaSignerId(
  bic: string | null | undefined,
  settings: { nordea_signer_id?: string | null } | null | undefined,
): NordeaSignerIdResolution {
  if (!isNordeaBic(bic)) return { ok: true, signerId: null }
  const signerId = settings?.nordea_signer_id?.trim()
  return signerId ? { ok: true, signerId } : { ok: false }
}
