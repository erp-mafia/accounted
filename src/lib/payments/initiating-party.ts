/**
 * The bank-assigned ids a pain.001 file names its parties by, and which of
 * them a company must store before a file can be made: the one place that
 * decides, per debtor bank, both the sender (GrpHdr/InitgPty/Id/OrgId/Othr)
 * and the debtor (PmtInf/Dbtr/Id/OrgId/Othr), for the supplier, tax-account
 * and salary files alike, so the generators cannot drift apart.
 *
 * A bank's file service checks these ids against the file agreement and
 * refuses a file whose ids it does not know, so the organisationsnummer is
 * written only where no guide in this repo says otherwise:
 *
 *  - Swedbank (SWEDSESS, savings banks included): InitgPty the SignerID and
 *    Dbtr the Corporate Pay agreement id, both SchmeNm/Cd BANK (swedbank.ts,
 *    crm#1117).
 *  - Nordea (NDEASESS): InitgPty the Signer ID with SchmeNm/Cd CUST and Dbtr
 *    the CCM agreement id with SchmeNm/Cd BANK (nordea.ts, crm#1530).
 *  - Every other bank: the organisationsnummer in both, with no scheme.
 *
 * A bank found to assign its own id gets its module, a line in each function
 * here and a Settings field; every file follows.
 */

import { resolveNordeaFileIds } from './nordea'
import { resolveSwedbankFileIds, type SwedbankFileIds } from './swedbank'

/** The company_settings columns that hold bank-assigned file ids. */
export type BankFileIdField =
  | 'swedbank_signer_id'
  | 'swedbank_corporate_pay_id'
  | 'nordea_signer_id'
  | 'nordea_agreement_id'

export interface BankFileIds {
  /** Swedbank's two ids: a Swedbank debtor only, and the file then takes Swedbank's ISO 2.0 form. */
  swedbank: SwedbankFileIds | null
  /** Nordea's Signer ID: a Nordea debtor only. */
  nordeaSignerId: string | null
  /** Nordea's CCM agreement id: a Nordea debtor only, and the file then takes Nordea's Dbtr form. */
  nordeaAgreementId: string | null
}

/** What the debtor's bank requires that settings lack: its name for the refusal, and the empty columns. */
export type BankFileIdsResolution =
  | { ok: true; ids: BankFileIds }
  | { ok: false; missing: 'swedbank_ids' | 'nordea_signer_id' | 'nordea_agreement_id'; fields: BankFileIdField[] }

/** The bank-assigned ids a file for a debtor at this BIC carries, read from company settings. */
export function resolveBankFileIds(
  bic: string | null | undefined,
  settings: Partial<Record<BankFileIdField, string | null>> | null | undefined,
): BankFileIdsResolution {
  const swedbank = resolveSwedbankFileIds(bic, settings)
  if (!swedbank.ok) {
    const fields = (['swedbank_signer_id', 'swedbank_corporate_pay_id'] as const).filter(
      (field) => !settings?.[field]?.trim(),
    )
    return { ok: false, missing: 'swedbank_ids', fields }
  }
  const nordea = resolveNordeaFileIds(bic, settings)
  if (!nordea.ok) {
    const fields = (['nordea_signer_id', 'nordea_agreement_id'] as const).filter((field) => !settings?.[field]?.trim())
    return { ok: false, missing: nordea.missing, fields }
  }
  return {
    ok: true,
    ids: {
      swedbank: swedbank.ids,
      nordeaSignerId: nordea.ids?.signerId ?? null,
      nordeaAgreementId: nordea.ids?.agreementId ?? null,
    },
  }
}

/** A party's Id/OrgId/Othr in a file: the id and its SchmeNm/Cd, null for the org number, which goes without. */
export interface FilePartyId {
  id: string
  scheme: 'BANK' | 'CUST' | null
}

/** The org number as a party id, or null when there is none. */
function orgNumberId(orgNumber: string): FilePartyId | null {
  const orgDigits = orgNumber.replace(/\D/g, '')
  return orgDigits ? { id: orgDigits, scheme: null } : null
}

/** The InitgPty id of a file for this debtor, or null when it has none: no bank-assigned id and no org number. */
export function initiatingPartyId(debtor: Partial<BankFileIds> & { orgNumber: string }): FilePartyId | null {
  if (debtor.swedbank) return { id: debtor.swedbank.signerId, scheme: 'BANK' }
  if (debtor.nordeaSignerId) return { id: debtor.nordeaSignerId, scheme: 'CUST' }
  return orgNumberId(debtor.orgNumber)
}

/**
 * The Dbtr id of a file for this debtor, or null when it has none: the
 * agreement id the debtor's bank assigned, else the org number. A Nordea
 * batch made before the agreement id was stored has none, and its file
 * regenerates with the org number as it was first downloaded.
 */
export function debtorPartyId(debtor: Partial<BankFileIds> & { orgNumber: string }): FilePartyId | null {
  if (debtor.swedbank) return { id: debtor.swedbank.corporatePayId, scheme: 'BANK' }
  if (debtor.nordeaAgreementId) return { id: debtor.nordeaAgreementId, scheme: 'BANK' }
  return orgNumberId(debtor.orgNumber)
}
