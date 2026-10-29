/**
 * Who a pain.001 file names as its sender (GrpHdr/InitgPty/Id/OrgId/Othr),
 * and which bank-assigned ids a company must store before a file can be
 * made: the one place that decides both per debtor bank, for the supplier,
 * tax-account and salary files alike.
 *
 * A bank's file service checks this id against the file agreement and
 * refuses a file whose id it does not know, so the organisationsnummer is
 * written only where no guide in this repo says otherwise:
 *
 *  - Swedbank (SWEDSESS, savings banks included): the SignerID with
 *    SchmeNm/Cd BANK, plus the Corporate Pay id in Dbtr (swedbank.ts,
 *    crm#1117).
 *  - Nordea (NDEASESS): the Signer ID with SchmeNm/Cd CUST (nordea.ts,
 *    crm#1530).
 *  - Every other bank: the organisationsnummer, with no scheme.
 *
 * A bank found to assign its own id gets its module, a line in each function
 * here and a Settings field; every file follows.
 */

import { resolveNordeaSignerId } from './nordea'
import { resolveSwedbankFileIds, type SwedbankFileIds } from './swedbank'

/** The company_settings columns that hold bank-assigned file ids. */
export type BankFileIdField = 'swedbank_signer_id' | 'swedbank_corporate_pay_id' | 'nordea_signer_id'

export interface BankFileIds {
  /** Swedbank's two ids: a Swedbank debtor only, and the file then takes Swedbank's ISO 2.0 form. */
  swedbank: SwedbankFileIds | null
  /** Nordea's Signer ID: a Nordea debtor only. */
  nordeaSignerId: string | null
}

/** What the debtor's bank requires that settings lack: its name for the refusal, and the empty columns. */
export type BankFileIdsResolution =
  | { ok: true; ids: BankFileIds }
  | { ok: false; missing: 'swedbank_ids' | 'nordea_signer_id'; fields: BankFileIdField[] }

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
  const nordea = resolveNordeaSignerId(bic, settings)
  if (!nordea.ok) return { ok: false, missing: 'nordea_signer_id', fields: ['nordea_signer_id'] }
  return { ok: true, ids: { swedbank: swedbank.ids, nordeaSignerId: nordea.signerId } }
}

/** GrpHdr/InitgPty/Id/OrgId/Othr: the id and its SchmeNm/Cd, null for the org number, which goes without. */
export interface InitiatingPartyId {
  id: string
  scheme: 'BANK' | 'CUST' | null
}

/** The InitgPty id of a file for this debtor, or null when it has none: no bank-assigned id and no org number. */
export function initiatingPartyId(debtor: Partial<BankFileIds> & { orgNumber: string }): InitiatingPartyId | null {
  if (debtor.swedbank) return { id: debtor.swedbank.signerId, scheme: 'BANK' }
  if (debtor.nordeaSignerId) return { id: debtor.nordeaSignerId, scheme: 'CUST' }
  const orgDigits = debtor.orgNumber.replace(/\D/g, '')
  return orgDigits ? { id: orgDigits, scheme: null } : null
}
