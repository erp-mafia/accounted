/**
 * Request bodies shared by the owner tax operations (lib/operations/
 * bolaget-owner-tax.ts, which add the path ids) and the dashboard routes
 * (/api/bolaget/owner-tax, where the ids are in the path).
 *
 * A counterparty is named by party id, or by name (and an org number for a
 * company). A personnummer never travels here: it is entered in Accounted,
 * under Aktiebok.
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { LOAN_ACCOUNT_PATTERN, LOAN_DIRECTIONS, LOAN_EXCEPTIONS, LOAN_KINDS, LOAN_RELATIONS, LOAN_STATUSES } from './types'

const UUID = z.string().uuid()
const AMOUNT = z.number().min(0).max(1e12)
const NOTE = z.string().trim().max(2000)
const ACCOUNT = z.string().regex(LOAN_ACCOUNT_PATTERN).describe('BAS account: 1360-1368 or 1680-1689 (the company lends), 2390-2399 or 2890-2899 (it borrows). Default 1685 or 2893.')
const RATE = z.number().min(0).max(100).describe('Yearly interest in percent, e.g. 4.5.')

export const K10InputsBody = z
  .object({
    saved_dividend_space: AMOUNT.nullish().describe('Sparat utdelningsutrymme brought forward from your K10 for the year before.'),
    cost_basis_override: AMOUNT.nullish().describe('Your omkostnadsbelopp for the shares held at the start of the year; null clears it.'),
    payroll_base_override: AMOUNT.nullish().describe('The löneunderlag when it differs from the payroll here (subsidiaries, state-subsidised pay); null clears it.'),
    own_pay_override: AMOUNT.nullish().describe('Your and your närståendes cash pay from the company the year before; null clears it.'),
    uses_basic_amount: z.boolean().nullish().describe('False when you use the grundbelopp in another company this year.'),
    note: NOTE.nullish(),
  })
  .strict()

export const OwnerLoanCreateBody = z
  .object({
    party_id: UUID.nullish().describe('The counterparty (from gnubok_get_share_register or the roles).'),
    party_name: z.string().trim().min(1).max(200).nullish().describe('Or the counterparty\'s name, when new.'),
    party_kind: z.enum(['person', 'company']).nullish(),
    party_org_number: z.string().trim().max(20).nullish().describe('A company counterparty\'s org number. Never a personnummer.'),
    kind: z.enum(LOAN_KINDS).nullish().describe('loan (default), or security the company gave for the party\'s debt (ABL 21:3).'),
    direction: z.enum(LOAN_DIRECTIONS).describe('lends: the company lends to the party; borrows: the party lends to the company.'),
    relation: z.enum(LOAN_RELATIONS).nullish().describe('What the registers cannot tell: group_insider, related_person or controlled_entity (with related_to_party_id). Default none.'),
    related_to_party_id: UUID.nullish().describe('The holder, board member or VD a related person or controlled entity goes through.'),
    relation_detail: z.string().trim().max(200).nullish().describe('E.g. make, sambo, barn.'),
    account: ACCOUNT.nullish(),
    principal: z.number().positive().max(1e12).describe('The amount lent or secured, SEK.'),
    outstanding: AMOUNT.nullish().describe('Still owed; the principal when omitted.'),
    interest_rate: RATE.nullish(),
    start_date: saneIsoDateSchema.describe('The day the loan was paid out or the security given (YYYY-MM-DD).'),
    maturity_date: saneIsoDateSchema.nullish(),
    terms: NOTE.nullish().describe('The main terms: repayment, security, notice.'),
    document_id: UUID.nullish().describe('The loan agreement in the archive.'),
    exception: z.enum(LOAN_EXCEPTIONS).nullish().describe('The låneförbud exception the loan is granted under: group_company, business_loan or dispensation.'),
    exception_note: NOTE.nullish().describe('Why the exception applies (e.g. Skatteverket\'s decision).'),
    note: NOTE.nullish(),
  })
  .strict()

export const OwnerLoanUpdateBody = z
  .object({
    relation: z.enum(LOAN_RELATIONS).nullish(),
    related_to_party_id: UUID.nullish(),
    relation_detail: z.string().trim().max(200).nullish(),
    account: ACCOUNT.nullish(),
    principal: z.number().positive().max(1e12).nullish(),
    outstanding: AMOUNT.nullish().describe('Still owed after a repayment.'),
    interest_rate: RATE.nullish(),
    maturity_date: saneIsoDateSchema.nullish(),
    terms: NOTE.nullish(),
    document_id: UUID.nullish(),
    exception: z.enum(LOAN_EXCEPTIONS).nullish(),
    exception_note: NOTE.nullish(),
    status: z.enum(LOAN_STATUSES).nullish().describe('repaid (with repaid_on) or cancelled (registered by mistake).'),
    repaid_on: saneIsoDateSchema.nullish(),
    note: NOTE.nullish(),
  })
  .strict()

export const LoanInterestBody = z
  .object({
    income_year: z.number().int().min(2000).max(2099),
    interest_amount: AMOUNT.describe('Interest paid (or received) on the loan in the year, SEK.'),
    tax_withheld: AMOUNT.nullish().describe('Preliminary tax withheld on interest the company paid (KU20 field 001).'),
    note: NOTE.nullish(),
  })
  .strict()
