/**
 * A Swedish domestic bank account (clearing + kontonummer) as the creditor of
 * a pain.001 credit transfer: the one encoder the salary file
 * (lib/salary/payment/pain001-generator.ts) and the supplier and tax-account
 * file (pain001-supplier.ts) share. Bankgiro and plusgiro payees never come
 * here; they are aliases with forms of their own in pain001-supplier.ts.
 *
 * The form belongs to the DEBTOR'S bank, never the payee's: the company
 * uploads the file to its own bank, and that bank alone reads CdtrAgt and
 * CdtrAcct. An employee with an account at SEB is read exactly like one at
 * Danske Bank by whichever bank the company uploads to.
 *
 * Every form carries the same routing parts (resolveDomesticBankAccount), so
 * a pair accepted at entry is carried by every form and no form can name a
 * different account than another. Three forms, each from the debtor bank's
 * own guide:
 *
 *  - 'split', every bank not named below: the 4-digit clearing as CdtrAgt
 *    ClrSysMmbId SESBA, the account without it as CdtrAcct Othr/Id, SchmeNm
 *    BBAN. Handelsbanken, "ISO 20022 pain.001 version 3, Country Specific
 *    Information for the future new Swedish payment infrastructure" v1.0.1
 *    (2025-12-18), Salary payment and Account payment: a national account
 *    number of 7-10 digits with the clearing number mandatory in Creditor
 *    Agent.
 *  - 'full_bban', the banks in FULL_BBAN_DEBTOR_BANKS: the same CdtrAgt, and
 *    CdtrAcct Othr/Id holds the clearing AND the account. An account whose
 *    clearing starts with 8 (Swedbank and the savings banks) is the 15-digit
 *    number Swedbank defines for it (swedbankCreditorAccount), which is also
 *    the length Nordea gives it.
 *  - 'swedbank_iso2', a Swedbank debtor with its file ids: Swedbank's MIG 2.0
 *    (lib/payments/swedbank.ts).
 */

import { payeeAccountParts } from '@/lib/salary/payment/bank-account'
import { swedbankCreditorAccount, type SwedbankFileIds } from './swedbank'

export type CreditorAccountForm = 'split' | 'full_bban' | 'swedbank_iso2'

/**
 * Debtor banks, by 8-character BIC, that read a domestic bank-account payee
 * from CdtrAcct alone and want the clearing number inside the BBAN.
 *
 * DABASESX, Danske Bank: "Danske Bank Message Implementation Guide (CGI-MP),
 * Customer Credit Transfer pain.001.001.03" v3.6 (2026-07-10), 2.80
 * CdtrAcct/Id/Othr/Id: "it must always be secured that the full account
 * number incl. registration number/sort code is stated". Its Appendix v5.3
 * (2026-08-05), Appendix C: ClrSysMmbId is not supported for Sweden, so the
 * SESBA clearing in CdtrAgt is not read. Its "Supported payment types and
 * examples" v5.3 (2026-08-18) addresses a PlusGiro payee as CdtrAcct Othr/Id
 * "PlusGiro number 2-8 digits" with Cd BBAN: a 7-digit account without its
 * clearing reads as a plusgiro number (crm#1218, crm#1219).
 *
 * NDEASESS, Nordea: "Corporate Access Payables, Appendix Sweden"
 * (2026-10-08), section 2.3.5, Structure for BBAN accounts on credit level in
 * payments: a bank account "Must include a 4-digit clearing code. Minimum
 * length 11 digits (including clearing code). Maximum length 14 digits", the
 * personkonto clearing is always 3300, and for a Swedbank clearing starting
 * with 8 "The clearing code must be 5 digits and consequently the maximum
 * length is 15 digits including the clearing code".
 *
 * List a bank only with its own implementation guide in hand.
 */
const FULL_BBAN_DEBTOR_BANKS: ReadonlySet<string> = new Set(['DABASESX', 'NDEASESS'])

/**
 * The creditor-account form a debtor's bank reads. The BIC is read as its
 * bank part: whitespace removed, upper case, first 8 characters, so
 * 'dabasesx' and 'DABASESXXXX' name the same bank.
 */
export function creditorAccountForm(debtorBic: string, swedbank: SwedbankFileIds | null | undefined): CreditorAccountForm {
  if (swedbank) return 'swedbank_iso2'
  const bank = debtorBic.replace(/\s/g, '').toUpperCase().slice(0, 8)
  return FULL_BBAN_DEBTOR_BANKS.has(bank) ? 'full_bban' : 'split'
}

/**
 * CdtrAgt ClrSysMmbId MmbId and CdtrAcct Othr/Id (SchmeNm BBAN) for one
 * domestic bank-account payee in the given form. Throws PayeeAccountError
 * (naming the payee, never the number) for a pair no file can carry.
 */
export function domesticCreditorAccount(
  payeeName: string,
  clearingInput: string | null | undefined,
  accountInput: string | null | undefined,
  form: CreditorAccountForm,
): { memberId: string; accountId: string } {
  if (form === 'swedbank_iso2') return swedbankCreditorAccount(payeeName, clearingInput, accountInput)

  const { clearing4, accountDigits } = payeeAccountParts(payeeName, clearingInput, accountInput)
  if (form === 'split') return { memberId: clearing4, accountId: accountDigits }

  // full_bban. A clearing starting with 8 is five digits inside the number:
  // the same 15 digits Swedbank's own guide states for the account.
  if (clearing4.startsWith('8')) {
    const { accountId } = swedbankCreditorAccount(payeeName, clearingInput, accountInput)
    return { memberId: clearing4, accountId }
  }
  return { memberId: clearing4, accountId: `${clearing4}${accountDigits}` }
}
