/**
 * Files to Bankgirot for Autogiro: mandates (medgivandeunderlag) and debits
 * (betalningsunderlag).
 *
 * Source: Bankgirot, "Bg Autogiro Teknisk manual" (november 2021), chapter 7.
 * A file is one or more sections; a section is an opening record (TK01:
 * write date, layout name AUTOGIRO, the payee's Kundnummer and bankgiro)
 * followed by its records. Files to Bankgirot have no end record. What v1
 * writes:
 *
 * - TK04 new mandate (or the answer to a mandate a payer signed in the
 *   internet bank: blank approves, "AV" rejects), TK03 cancel a mandate.
 * - TK82 one debit (inbetalning) on a payment day, period code 0 ("En gång"):
 *   every invoice is its own debit, so Bankgirot's self-renewing orders,
 *   payouts (TK32) and cancellation by file (TK23-TK29) are not written.
 *
 * Bankgirot handles a file in the order it arrives; a mandate must be sent
 * before payments on it, and changes to a payment not on the same day as the
 * payment (6.1.1). The seal goes on afterwards (seal.ts).
 */
import {
  AutogiroFormatError,
  LINE_END,
  alpha,
  blank,
  numeric,
  record,
  writeAmount,
  writeBankgiro,
  writeDate,
  type AutogiroBankAccount,
} from './records'

export interface AutogiroPayee {
  /** The payee's Kundnummer at Bankgirot, from its Autogiro agreement (up to 6 digits). */
  customerNumber: string
  /** The bankgiro the debits are credited to. */
  bankgiro: string
}

export type AutogiroIdentity =
  | { kind: 'person'; /** ÅÅÅÅMMDDNNNN */ number: string }
  | { kind: 'organisation'; /** 10 digits */ number: string }

export type MandateInstruction =
  /** A mandate on the payer's bank account (paper form or the payee's own web form). */
  | { kind: 'new'; payerNumber: string; account: AutogiroBankAccount; identity: AutogiroIdentity }
  /** A mandate on the payer's bankgiro: the payer number is that bankgiro. */
  | { kind: 'new_on_bankgiro'; payerBankgiro: string }
  /** The answer to a mandate the payer signed in its internet bank (Medgivanden via Internetbanken). */
  | { kind: 'answer_internet_bank'; payerNumber: string; account: AutogiroBankAccount; identity: AutogiroIdentity; approve: boolean }
  | { kind: 'cancel'; payerNumber: string }

export interface AutogiroDebit {
  /** The payment day, YYYY-MM-DD; Bankgirot debits on the next bank day when it is not one. */
  date: string
  payerNumber: string
  /** SEK, positive. */
  amount: number
  /** The payee's own reference on the debit (up to 16 characters), returned in every report: the invoice's OCR. */
  reference: string
}

function opening(payee: AutogiroPayee, writtenOn: string): string {
  return record([
    '01',
    writeDate(writtenOn, 'Skrivdag'),
    'AUTOGIRO',
    blank(44),
    numeric(payee.customerNumber, 6, 'Kundnummer'),
    writeBankgiro(payee.bankgiro, 'Betalningsmottagarens bankgironummer'),
    blank(2),
  ])
}

function payerNumber(value: string): string {
  return numeric(value, 16, 'Betalarnummer')
}

function bankAccount(account: AutogiroBankAccount): string {
  if (account.clearing.length !== 4 || !/^\d+$/.test(account.clearing)) {
    throw new AutogiroFormatError('Clearingnumret ska vara 4 siffror.', 'Clearingnummer')
  }
  return account.clearing + numeric(account.number, 12, 'Kontonummer')
}

function identity(value: AutogiroIdentity): string {
  if (value.kind === 'person') {
    if (!/^\d{12}$/.test(value.number)) throw new AutogiroFormatError('Personnumret ska vara 12 siffror (ÅÅÅÅMMDDNNNN).', 'Personnummer')
    return value.number
  }
  if (!/^\d{10}$/.test(value.number)) throw new AutogiroFormatError('Organisationsnumret ska vara 10 siffror.', 'Organisationsnummer')
  return `00${value.number}`
}

function mandateRecord(bankgiro: string, instruction: MandateInstruction): string {
  switch (instruction.kind) {
    case 'cancel':
      return record(['03', bankgiro, payerNumber(instruction.payerNumber), blank(52)])
    case 'new_on_bankgiro':
      return record(['04', bankgiro, payerNumber(writeBankgiro(instruction.payerBankgiro, 'Betalarens bankgironummer')), blank(52)])
    case 'new':
    case 'answer_internet_bank':
      return record([
        '04',
        bankgiro,
        payerNumber(instruction.payerNumber),
        bankAccount(instruction.account),
        identity(instruction.identity),
        blank(20),
        instruction.kind === 'answer_internet_bank' && !instruction.approve ? 'AV' : blank(2),
        blank(2),
      ])
  }
}

/** A mandate section (medgivandeunderlag): TK01 and one record per instruction. */
export function mandateSection(payee: AutogiroPayee, writtenOn: string, instructions: MandateInstruction[]): string[] {
  if (instructions.length === 0) throw new AutogiroFormatError('Medgivandeunderlaget innehåller inga medgivanden.', 'medgivanden')
  const bankgiro = writeBankgiro(payee.bankgiro, 'Betalningsmottagarens bankgironummer')
  return [opening(payee, writtenOn), ...instructions.map((instruction) => mandateRecord(bankgiro, instruction))]
}

/** A payment section (betalningsunderlag): TK01 and one TK82 per debit. No debit may fall before the write date. */
export function debitSection(payee: AutogiroPayee, writtenOn: string, debits: AutogiroDebit[]): string[] {
  if (debits.length === 0) throw new AutogiroFormatError('Betalningsunderlaget innehåller inga betalningar.', 'betalningar')
  const bankgiro = writeBankgiro(payee.bankgiro, 'Betalningsmottagarens bankgironummer')
  return [
    opening(payee, writtenOn),
    ...debits.map((debit) => {
      const date = writeDate(debit.date, 'Betalningsdag')
      if (debit.date < writtenOn) throw new AutogiroFormatError('Betalningsdagen har redan passerat.', 'Betalningsdag')
      return record([
        '82',
        date,
        '0',
        blank(3),
        blank(1),
        payerNumber(debit.payerNumber),
        writeAmount(debit.amount, 'Belopp'),
        bankgiro,
        alpha(debit.reference, 16, 'Referens'),
        blank(11),
      ])
    }),
  ]
}

/** The file: its sections' records, each ended with <CRLF>. Encode it with encodeAutogiroFile before upload. */
export function autogiroFile(sections: string[][]): string {
  return sections
    .flat()
    .map((r) => r + LINE_END)
    .join('')
}

/** The file's bytes in ISO 8859-1, the character set Bankgirot recommends for ASCII files (6.1.4). */
export function encodeAutogiroFile(content: string): Buffer {
  return Buffer.from(content, 'latin1')
}
