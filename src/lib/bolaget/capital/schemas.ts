/**
 * Request bodies shared by the capital operations (lib/operations/
 * bolaget-capital.ts, which add the path ids) and the dashboard routes
 * (/api/bolaget/capital, where the id is in the path), plus the bodies of
 * the app-only steps: the "who received" step for a dividend already in
 * the ledger, and the KU31 answers per year.
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { DIVIDEND_DECIDED_BY, DIVIDEND_SOURCE_ACCOUNTS } from './types'

const UUID = z.string().uuid()
const NAME = z.string().trim().min(1).max(200)
const PARTY_KIND = z.enum(['person', 'company'])
const ORG = z.string().trim().max(20)
const BANK = z.string().regex(/^19\d\d$/).describe("Bank account (BAS 19xx). Default: the company's primary bank account.")

/** The account a tillskott is booked against: a bank account (19xx), or 1685 while only promised. */
export const ContributionCounterAccount = z.string().regex(/^(19\d\d|1685)$/).describe("Bank account 19xx (default: the company's primary bank account), or 1685 while only promised.")

export const DividendBookBody = z
  .object({
    source_account: z.enum(DIVIDEND_SOURCE_ACCOUNTS).nullish().describe('2098 or 2091; chosen from the balance on the decision day when omitted.'),
    prudence_confirmed: z.boolean().nullish().describe('Confirms the försiktighetsregel assessment (ABL 17:3) now.'),
  })
  .strict()

export const DividendPayBody = z
  .object({
    paid_on: saneIsoDateSchema.nullish().describe('The day the money left; the betalningsdag when omitted.'),
    bank_account: BANK.nullish(),
    journal_entry_id: UUID.nullish().describe('A payout verifikat already posted (D 2898 / K bank) to link instead of booking.'),
  })
  .strict()

export const CapitalChangeBookBody = z
  .object({
    step: z.enum(['payment', 'registration']),
    date: saneIsoDateSchema.describe('The payment day or the registration day.'),
    bank_account: BANK.nullish(),
  })
  .strict()

export const LedgerDividendBody = z
  .object({
    decided_on: saneIsoDateSchema,
    decided_by: z.enum(DIVIDEND_DECIDED_BY),
    paid_on: saneIsoDateSchema,
    payout_entry_id: UUID,
    decision_entry_id: UUID.nullish(),
    recipients: z
      .array(
        z
          .object({
            party_id: UUID.nullish(),
            name: NAME.nullish(),
            kind: PARTY_KIND.nullish(),
            org_number: ORG.nullish(),
            amount: z.number().positive().max(1e12),
            share_count: z.number().int().min(0).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    note: z.string().trim().max(2000).nullish(),
  })
  .strict()

export const Ku31SettingsBody = z
  .object({
    famansforetag: z.boolean().nullish(),
    contact_name: z.string().trim().max(50).nullish(),
    contact_phone: z.string().trim().max(20).nullish(),
    contact_email: z.string().trim().max(254).nullish(),
  })
  .strict()
