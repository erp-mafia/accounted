import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'

/**
 * Accounts whose postings indicate a kontrolluppgifter obligation:
 * 2898 outtagen vinstutdelning (KU31 on utdelning), 2393/2893 lån från
 * närstående (KU20 on interest paid to the owner). 2091 is deliberately NOT
 * a signal: every closed year moves balanserad vinst, so it would flag
 * nearly all aktiebolag.
 */
const KU_SIGNAL_ACCOUNTS = ['2898', '2393', '2893']

/** How far back to look for KU-relevant postings. */
const LOOKBACK_MONTHS = 15

/**
 * GET /api/settings/ku-signal
 *
 * Derived suggestion signal for the tax settings page: an aktiebolag whose
 * ledger shows utdelning or ägarlån postings likely owes kontrolluppgifter
 * on 31 January (SFL 24 kap. 1 §), but KU31 is never covered by AGI so the
 * obligation is easy to miss. The settings UI uses this to prompt the user
 * to enable the KU deadline; it never flips the flag itself (mirrors the
 * EU-trade signal from the periodisk sammanställning suggestion).
 */
export const GET = withRouteContext(
  'settings.ku_signal',
  async (_request, { supabase, companyId, log }) => {
    // Kontrolluppgifter for utdelning/ägarlån only exist for aktiebolag; an
    // enskild firma has no shareholder to report on.
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

    if (settings?.entity_type !== 'aktiebolag') {
      return NextResponse.json({ data: { has_ku_signal: false } })
    }

    const since = new Date()
    since.setMonth(since.getMonth() - LOOKBACK_MONTHS)
    const sinceStr = since.toISOString().split('T')[0]

    const lines = await fetchEntryLines<{ account_number: string }>({
      supabase,
      lineColumns: 'account_number',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .in('status', ['posted', 'reversed'])
          .gte('entry_date', sinceStr),
      filterLines: (q: EntryLinesQuery) => q.in('account_number', KU_SIGNAL_ACCOUNTS),
    })

    return NextResponse.json({ data: { has_ku_signal: lines.length > 0 } })
  },
)
