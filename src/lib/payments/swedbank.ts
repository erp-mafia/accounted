/**
 * Swedbank's file service for pain.001: MIG 2.0, "Swedbank pain.001 ISO 2.0",
 * the service the internet bank validates uploaded files against. Here are
 * the identifiers and account forms it demands that no other bank's guide in
 * this repo shares, defined once for the supplier, tax-account and salary
 * files and for Settings, so the gate, the file and the settings row agree
 * on what a Swedbank company is.
 *
 * Source: Swedbank "Message Implementation Guide pain.001.001.03, Version
 * 2.0.0" (2026-03-09, published as preliminary), its Appendix v2.1.0
 * (2026-04-23) and the ISO 2.0 example files (transfer, salary), all on
 * swedbank.se under Betala via fil, MIG. The older MIG 1.0 service (agreement
 * id 06<orgnr>Bnnn, bankgiro debit) is not produced: one file cannot satisfy
 * both, and the uploads customers make go to 2.0 (crm#1117). 2.0 pays to
 * bank accounts only (swedbankIso2PaysPayee, crm#1156).
 */

import { luhnCheckDigit } from '@/lib/bankgiro/luhn'
import { normalizeBankNumber, payeeAccountParts, settingsBankBic } from '@/lib/payments/bank-account'

/** The only DbtrAgt BIC MIG 2.0 allows besides NOTPROVIDED. */
export const SWEDBANK_BIC = 'SWEDSESS'

/**
 * Whether a BIC names Swedbank, read as its bank part: whitespace removed,
 * upper case, first 8 characters, so 'swedsess' and 'SWEDSESSXXX' match.
 */
export function isSwedbankBic(bic: string | null | undefined): boolean {
  return (bic ?? '').replace(/\s/g, '').toUpperCase().slice(0, 8) === SWEDBANK_BIC
}

/**
 * Whether the company's bank resolves to Swedbank by the chain the payment
 * files use: the saved BIC, else the clearing number, else the bank name.
 * The savings banks (clearing 8xxx) resolve to SWEDSESS as well: they run on
 * Swedbank's file service.
 */
export function isSwedbankCompany(settings: Parameters<typeof settingsBankBic>[0]): boolean {
  return isSwedbankBic(settingsBankBic(settings))
}

export interface SwedbankFileIds {
  /** GrpHdr/InitgPty/Id/OrgId/Othr/Id with SchmeNm/Cd BANK: nnnnnnnnnORInnnn. */
  signerId: string
  /** PmtInf/Dbtr/Id/OrgId/Othr/Id with SchmeNm/Cd BANK: nnnnnnnnnCPOnnnn. */
  corporatePayId: string
}

/** MIG 2.0: "Swedbank SignerID format : nnnnnnnnnORInnnn (E.g. 123456789ORI0001)". */
export const SWEDBANK_SIGNER_ID_PATTERN = /^\d{9}ORI\d{4}$/

/** MIG 2.0: "Swedbank Corporate Pay ID format: nnnnnnnnnCPOnnnn (E.g. 123456789CPO0001)". */
export const SWEDBANK_CORPORATE_PAY_ID_PATTERN = /^\d{9}CPO\d{4}$/

/**
 * The agreement number of Swedbank's ISO 20022 1.0 file service, which the
 * bank hands a company for "Filöverföring via internetbanken": "06", the
 * 10-digit organisationsnummer, then B001 (payments) or R001 (reporting), 16
 * characters (MIG 1.0's nnnnnnnnnnnnAnnn). The files here follow 2.0 (see above), so both id fields refuse
 * it by name instead of as a wrong format: Swedbank tells the customer to
 * enter it in the business system (agent feedback seq 2321961).
 */
export const SWEDBANK_ISO1_AGREEMENT_PATTERN = /^06\d{10}[BR]\d{3}$/

/** An id as typed, spaces and hyphens removed, upper case: "123456789-ori-0001" is "123456789ORI0001". */
export function normalizeSwedbankId(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

export type SwedbankFileIdsResolution = { ok: true; ids: SwedbankFileIds | null } | { ok: false }

/**
 * The Swedbank ids a payment file for this debtor carries: null for every
 * other bank, both ids for Swedbank, or not ok when the debtor is Swedbank
 * and either id is missing, because Swedbank refuses such a file at upload
 * ("Aktivt id för fullmaktshavare saknas").
 */
export function resolveSwedbankFileIds(
  bic: string | null | undefined,
  settings:
    | { swedbank_signer_id?: string | null; swedbank_corporate_pay_id?: string | null }
    | null
    | undefined,
): SwedbankFileIdsResolution {
  if (!isSwedbankBic(bic)) return { ok: true, ids: null }
  const signerId = settings?.swedbank_signer_id?.trim()
  const corporatePayId = settings?.swedbank_corporate_pay_id?.trim()
  if (!signerId || !corporatePayId) return { ok: false }
  return { ok: true, ids: { signerId, corporatePayId } }
}

/**
 * Whether Swedbank's ISO 2.0 file service pays to a payee of this type: a
 * bank account only, never a bankgiro or plusgiro number (crm#1156).
 *
 * Swedbank's MIG page (swedbank.se, Betala via fil, MIG) lists what each
 * service offers. 2.0: "Överföringar mellan egna konton eller till andra
 * konton" and "Löneutbetalningar". 1.0: "Leverantörsbetalningar" and
 * "Bank/Plusgiro betalningar". Swedbank's support, on a supplier payment file
 * a customer uploaded under an ISO 2.0 agreement for utbetalningar: payments
 * to bankgiro are not allowed in that ISO 2.0 utbetalning, "only BBAN to BBAN
 * or IBAN to IBAN". The preliminary MIG 2.0 and its Appendix v2.1.0 already
 * describe alias payees (BGNR, PGNR) and supplier payments for a later
 * iteration of the service; the file generator keeps that form, and this is
 * the one place to open when Swedbank lists them under 2.0.
 */
export function swedbankIso2PaysPayee(payeeType: 'bankgiro' | 'plusgiro' | 'bank_account'): boolean {
  return payeeType === 'bank_account'
}

/**
 * Creditor routing for a domestic bank account in a Swedbank ISO 2.0 file
 * (Appendix, Payee Account Identification):
 *
 *  - A 4-digit clearing keeps the separate form, Option 2: CdtrAgt MmbId
 *    CCCC, CdtrAcct BBAN the account without the clearing.
 *  - A clearing starting with 8 (Swedbank and the savings banks) "must always
 *    be stated" as MmbId 8CCCC and BBAN 8CCCC + zero fill + account, always
 *    15 digits. A clearing stored with four digits gets its fifth, the mod 10
 *    check digit of the first four, the way the invoice QR derives it.
 *
 * Throws PayeeAccountError (naming the payee) for an account no file can
 * carry, exactly as payeeAccountParts does for the other banks.
 */
export function swedbankCreditorAccount(
  payeeName: string,
  clearingInput: string | null | undefined,
  accountInput: string | null | undefined,
): { memberId: string; accountId: string } {
  const { clearing4, accountDigits } = payeeAccountParts(payeeName, clearingInput, accountInput)
  if (!clearing4.startsWith('8')) return { memberId: clearing4, accountId: accountDigits }
  const clearing = normalizeBankNumber(clearingInput)
  // The resolver carries a 5-digit clearing's last digit in front of the account.
  const account = clearing.length === 5 ? accountDigits.slice(1) : accountDigits
  const clearing5 = clearing.length === 5 ? clearing : `${clearing4}${luhnCheckDigit(clearing4)}`
  return { memberId: clearing5, accountId: `${clearing5}${account.padStart(10, '0')}` }
}
