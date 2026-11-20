/**
 * Nordea's file service for pain.001: the two ids it identifies a file by,
 * defined once for the supplier, tax-account and salary files and for
 * Settings (crm#1530).
 *
 *  - The Signer ID, GrpHdr/InitgPty/Id/OrgId/Othr/Id with SchmeNm/Cd CUST:
 *    "CUST: Customer identification, i.e. "Signer Id" as agreed with (or
 *    assigned by) Nordea". Nordea's file upload checks it against the file
 *    agreement and refuses any other id ("Filen avvisades - fel Signer ID
 *    ... Ditt Signer ID är NB...").
 *  - The CCM agreement id, PmtInf/Dbtr/Id/OrgId/Othr/Id with SchmeNm/Cd BANK:
 *    "Customer agreement (Nordea's CCM agreement) identification with Nordea
 *    is mandatory (BANK)". Nordea matches the file to the Corporate Cash
 *    Management agreement, and so to the accounts it may debit, by it, and
 *    rejects a file without it after upload.
 *
 * Sources, all on nordea.com: "Corporate Access Payables, Message
 * Implementation Guidelines pain.001.001.03", MIG version 2.4 (2026-06-24),
 * and "pain.001.001.09", MIG version 1.4 (2026-09-16); "Corporate Access
 * Payables, Example per payment type", version 2.6 (2026-06-22), section 1
 * ("Explanation of code BANK: Unique identification of Corporate Cash
 * Management agreement with Nordea") and the Sweden examples 5.4 and 5.9,
 * whose Dbtr also carries PstlAdr/Ctry SE ("Debtor Name, Country and
 * Identification are required") and whose PmtTpInf names SvcLvl NURG;
 * "Service description (for ERP vendors) Corporate Access Lite in Nordea
 * Business", version 1.8 (2026-06-10): a Nordea Business agreement id
 * starts with NB (NB123456), a Corporate Netbank one is digits (1234567890).
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
 * The CCM agreement id: NB and digits at Nordea Business, digits at
 * Corporate Netbank, in a Max35Text. Stored normalised like the Signer ID.
 */
export const NORDEA_AGREEMENT_ID_PATTERN = /^[A-Z0-9]{1,35}$/

/**
 * Why a Nordea debtor's pain.001 cannot be made, in Swedish: Nordea refuses a
 * file whose Signer ID is not the one in the file agreement.
 */
export const NORDEA_SIGNER_ID_MISSING_SV =
  'Nordea kräver företagets Signer ID och avtals-ID i betalfilen. Du får båda av Nordea, och Nordea visar Signer ID när en fil avvisas för fel Signer ID. Fyll i dem under Inställningar → Fakturor.'

/**
 * Why a Nordea debtor's pain.001 cannot be made when only the agreement id
 * is missing, in Swedish: Nordea rejects a file it cannot match to the CCM
 * agreement.
 */
export const NORDEA_AGREEMENT_ID_MISSING_SV =
  'Nordea kräver företagets avtals-ID (CCM-avtalet) i betalfilen. Du får det av Nordea; i Nordea Business börjar det med NB, till exempel NB123456. Fyll i det under Inställningar → Fakturor.'

export interface NordeaFileIds {
  /** GrpHdr/InitgPty/Id/OrgId/Othr/Id with SchmeNm/Cd CUST. */
  signerId: string
  /** PmtInf/Dbtr/Id/OrgId/Othr/Id with SchmeNm/Cd BANK. */
  agreementId: string
}

export type NordeaFileIdsResolution =
  | { ok: true; ids: NordeaFileIds | null }
  | { ok: false; missing: 'nordea_signer_id' | 'nordea_agreement_id' }

/**
 * The Nordea ids a payment file for this debtor carries: null for every
 * other bank, both ids for Nordea, or not ok when the debtor is Nordea and
 * either id is missing, because Nordea refuses such a file. A missing Signer
 * ID is named first: without it the upload itself fails.
 */
export function resolveNordeaFileIds(
  bic: string | null | undefined,
  settings: { nordea_signer_id?: string | null; nordea_agreement_id?: string | null } | null | undefined,
): NordeaFileIdsResolution {
  if (!isNordeaBic(bic)) return { ok: true, ids: null }
  const signerId = settings?.nordea_signer_id?.trim()
  const agreementId = settings?.nordea_agreement_id?.trim()
  if (!signerId) return { ok: false, missing: 'nordea_signer_id' }
  if (!agreementId) return { ok: false, missing: 'nordea_agreement_id' }
  return { ok: true, ids: { signerId, agreementId } }
}
