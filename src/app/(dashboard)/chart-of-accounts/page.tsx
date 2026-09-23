import ChartOfAccountsManager from '@/components/bookkeeping/ChartOfAccountsManager'

/**
 * Kontoplan (chart of accounts): its own page in the Redovisning group, peer to
 * Bokföring. It is reference/configuration (activate/add/edit accounts, browse
 * the BAS catalog), not a daily task, so it lives beside the ledger rather than
 * as a co-equal tab inside it. Balances/lookup stay in Rapporter (Huvudbok).
 *
 * The manager owns the whole page chrome (concept scene 30 header with the
 * BAS-version chip and the actions) since every control needs client state.
 */
export default function ChartOfAccountsPage() {
  return <ChartOfAccountsManager />
}
