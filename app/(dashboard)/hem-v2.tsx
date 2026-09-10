import type { ReactNode } from 'react'
import { countCompletedSieImports, countInboxItems, countTransactions, readActiveBankConnections } from './hem-reads'
import AttGoraV2 from '@/components/attgora/AttGoraV2'
import {
  getWorklistCounts,
  listExpensePayoutsDue,
  listSuggestedMatches,
  SUGGESTED_MATCH_SCAN_CAP,
} from '@/lib/worklist'
import { expiringBankConnectionsFrom } from '@/lib/notices/categories'
import type { AttGoraSetupFlags } from '@/lib/worklist/tasks-v2'
import { getDashboardAuthContext } from './request-context'

type BankConnectionRow = {
  id: string
  status: string
  consent_expires: string | null
  bank_name: string
  last_sie_sweep: unknown
}

/**
 * Hem in shell v2: the data wave behind the three-pane Att göra
 * (dev_docs/ui_v2_build_plan.md, PR 3). Same sources as HemPanesSection
 * (lib/worklist, suggested matches, expense payouts, bank connections) plus
 * the first-run gates the task tree needs for its Kom igång group. Runs as
 * one async server component behind Suspense so the top bar paints first.
 */
export async function HemV2Section({
  companyId,
  userId,
  now,
  setupOpen,
  hasSkatteverketConnected,
  hasMcpKey,
  checklist,
  notices,
}: {
  companyId: string
  userId: string
  now: Date
  setupOpen: boolean
  hasSkatteverketConnected: boolean
  hasMcpKey: boolean
  checklist: ReactNode
  notices: ReactNode
}) {
  const { supabase } = await getDashboardAuthContext()
  void userId
  const suggestedMatchesPromise = listSuggestedMatches(supabase, companyId, SUGGESTED_MATCH_SCAN_CAP)
  const expensePayoutsPromise = listExpensePayoutsDue(supabase, companyId)
  const [
    worklist,
    suggestedMatches,
    expensePayouts,
    bankConnectionsRes,
    { count: transactionCount },
    { count: sieImportCount },
    { count: inboxItemCount },
  ] = await Promise.all([
    getWorklistCounts(supabase, companyId, {
      suggestedMatches: suggestedMatchesPromise,
      expensePayoutsDue: expensePayoutsPromise,
    }),
    suggestedMatchesPromise,
    expensePayoutsPromise,
    readActiveBankConnections(companyId),
    // The three first-run gates the tree shows. The checklist island reads
    // the same three; the request cache in hem-reads.ts makes that one read.
    setupOpen ? countTransactions(companyId) : Promise.resolve({ count: null as number | null }),
    setupOpen ? countCompletedSieImports(companyId) : Promise.resolve({ count: null as number | null }),
    setupOpen ? countInboxItems(companyId) : Promise.resolve({ count: null as number | null }),
  ])

  const bankConnections = (bankConnectionsRes.data ?? []) as BankConnectionRow[]
  // A failed fetch must not tell a connected company that no bank is
  // connected (same degrade rule as HemPanesSection).
  const hasActiveBankConnection = !!bankConnectionsRes.error || bankConnections.length > 0
  const expiringBankConnections = expiringBankConnectionsFrom(bankConnections, now)

  const setup: AttGoraSetupFlags | null = setupOpen
    ? {
        open: true,
        bank: bankConnections.length > 0 || (transactionCount || 0) > 0,
        import: (sieImportCount || 0) > 0,
        skatteverket: hasSkatteverketConnected,
        receipts: (inboxItemCount || 0) > 0,
        claude: hasMcpKey,
      }
    : null

  return (
    <AttGoraV2
      worklist={worklist}
      suggestedMatches={suggestedMatches}
      expensePayouts={expensePayouts}
      expiringBankConnections={expiringBankConnections}
      hasActiveBankConnection={hasActiveBankConnection}
      setup={setup}
      claudeConnected={hasMcpKey}
      checklist={checklist}
      notices={notices}
    />
  )
}
