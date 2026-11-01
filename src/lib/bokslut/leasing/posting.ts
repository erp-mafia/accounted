import type { SupabaseClient } from '@supabase/supabase-js'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingEvidence } from '@/lib/core/bookkeeping/year-end-business-events'
import type { JournalEntry } from '@/types'
import {
  leaseSchedule,
  leaseYear,
  yearEndLines,
  type FinanceLease,
  type LeaseAccounts,
  type LeaseLine,
} from './finance-lease'

/**
 * Books the year-end adjustment for the company's finansiella leasingavtal
 * (K3 20.9, 20.11) through the posting port: one year_end verifikat for
 * every lease, so the engine draws the number and the period lock and the
 * balance trigger apply.
 */

export function financeLeaseBusinessEvent(args: { fiscalPeriodId: string; periodEnd: string; amount: number }): BusinessEventDraft {
  return {
    kind: 'year_end.closing',
    category: null,
    occurredOn: args.periodEnd,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    ...postingEvidence(linkBasisColumns('user_created')),
    mappingVersion: mappingVersion('financeLease'),
    jurisdiction: 'SE',
  }
}

export interface BookFinanceLeasesArgs {
  supabase: SupabaseClient
  companyId: string
  userId: string
  fiscalPeriodId: string
  periodStart: string
  periodEnd: string
  leases: ReadonlyArray<{ lease: FinanceLease; accounts: LeaseAccounts; openingAccruedInterest: number }>
}

export function financeLeaseYearEndLines(args: Pick<BookFinanceLeasesArgs, 'periodStart' | 'periodEnd' | 'leases'>): LeaseLine[] {
  return args.leases.flatMap(({ lease, accounts, openingAccruedInterest }) => {
    const year = leaseYear(lease, leaseSchedule(lease), args.periodStart, args.periodEnd)
    return yearEndLines(lease, year, accounts, openingAccruedInterest)
  })
}

export async function bookFinanceLeasesYearEnd(args: BookFinanceLeasesArgs): Promise<JournalEntry | null> {
  const lines = financeLeaseYearEndLines(args)
  if (lines.length === 0) return null
  const amount = lines.reduce((sum, line) => sum + line.debit_amount, 0)
  return postingPort.postJournalEntry({
    supabase: args.supabase,
    companyId: args.companyId,
    userId: args.userId,
    event: () => financeLeaseBusinessEvent({ fiscalPeriodId: args.fiscalPeriodId, periodEnd: args.periodEnd, amount }),
    input: {
      fiscal_period_id: args.fiscalPeriodId,
      entry_date: args.periodEnd,
      description: `Finansiella leasingavtal ${args.periodEnd}`,
      source_type: 'year_end',
      lines,
    },
  })
}
