import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { isEntityType, usesInk2 } from '@/lib/company/entity-type'
import { todayIsoStockholm } from '@/lib/dates/iso'
import {
  DIVIDEND_ACCOUNT,
  isOwnerLoanInterestAccount,
  kuSignalTriggers,
  OWNER_LOAN_ACCOUNTS,
  type KuSignalLine,
} from '@/lib/tax/ku-signal'

/**
 * GET /api/settings/ku-signal
 *
 * Derived suggestion signal for the tax settings page: an aktiebolag (or
 * ekonomisk förening) whose ledger shows interest paid on a loan from the
 * owner or utdelning owes kontrolluppgifter on 31 January (SFL 17 kap.,
 * 24 kap. 1 §), and neither is covered by AGI, so the obligation is easy to
 * miss. The rule and its sources live in lib/tax/ku-signal.ts. The answer
 * names what triggered it (`triggers`), so the page can say which postings
 * and amounts it means. A loan on 2393/2893 without interest is no signal: it
 * used to be, and fired for every interest-free ägarlån (crm#1171).
 *
 * The window is the previous and the current calendar year: the inkomstår of
 * the next kontrolluppgifter and the one being booked. The settings UI uses
 * the signal to prompt the user to enable the KU deadline; it never flips
 * the flag itself (mirrors the EU-trade signal).
 */
export const GET = withRouteContext(
  'settings.ku_signal',
  async (_request, { supabase, companyId, log }) => {
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('entity_type')
      .eq('company_id', companyId)
      .maybeSingle()
    if (settingsError) {
      // Best-effort signal: treat as "no signal" but keep the failure
      // observable for forensics.
      log.warn('ku-signal: company_settings lookup failed', {
        code: settingsError.code,
      })
    }

    // KU31 on utdelning and kontrolluppgift on interest to members apply to
    // every form that files INK2 (aktiebolag, ekonomisk förening).
    if (!isEntityType(settings?.entity_type) || !usesInk2(settings.entity_type)) {
      return NextResponse.json({ data: { has_ku_signal: false, triggers: [] } })
    }

    const since = `${Number(todayIsoStockholm().slice(0, 4)) - 1}-01-01`

    const [rows, closing] = await Promise.all([
      fetchEntryLines<{
        journal_entry_id: string
        account_number: string
        debit_amount: number | string
        credit_amount: number | string
        journal_entries: { entry_date: string }
      }>({
        supabase,
        entryColumns: 'id, entry_date',
        lineColumns: 'journal_entry_id, account_number, debit_amount, credit_amount',
        filterEntries: (q: EntryLinesQuery) =>
          q
            .eq('company_id', companyId)
            .eq('status', 'posted')
            .neq('source_type', 'storno')
            .gte('entry_date', since),
        // The loan, dividend and räntekostnad accounts; the rule pairs them
        // per verifikat.
        filterLines: (q: EntryLinesQuery) =>
          q.or(
            `account_number.in.(${[...OWNER_LOAN_ACCOUNTS, DIVIDEND_ACCOUNT].join(',')}),` +
              'and(account_number.gte.8400,account_number.lte.8429)',
          ),
      }),
      supabase
        .from('fiscal_periods')
        .select('closing_entry_id')
        .eq('company_id', companyId)
        .not('closing_entry_id', 'is', null),
    ])
    if (closing.error) {
      log.warn('ku-signal: fiscal_periods lookup failed', { code: closing.error.code })
    }

    const lines: KuSignalLine[] = rows
      .filter((r) => r.account_number === DIVIDEND_ACCOUNT
        || (OWNER_LOAN_ACCOUNTS as readonly string[]).includes(r.account_number)
        || isOwnerLoanInterestAccount(r.account_number))
      .map((r) => ({
        journal_entry_id: r.journal_entry_id,
        account_number: r.account_number,
        debit_amount: Number(r.debit_amount) || 0,
        credit_amount: Number(r.credit_amount) || 0,
        entry_date: r.journal_entries.entry_date,
      }))
    const closingIds = new Set(
      ((closing.data ?? []) as Array<{ closing_entry_id: string | null }>)
        .map((r) => r.closing_entry_id)
        .filter((id): id is string => !!id),
    )
    const triggers = kuSignalTriggers(lines, closingIds)

    return NextResponse.json({ data: { has_ku_signal: triggers.length > 0, triggers } })
  },
)
