import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import ChartOfAccountsManager from '@/components/bookkeeping/ChartOfAccountsManager'

/**
 * Kontoplan (chart of accounts): its own page in the Redovisning group, peer to
 * Bokföring. It is reference/configuration (activate/add/edit accounts, browse
 * the BAS catalog), not a daily task, so it lives beside the ledger rather than
 * as a co-equal tab inside it. Balances/lookup stay in Rapporter (Huvudbok).
 */
export default async function ChartOfAccountsPage() {
  const t = await getTranslations('nav')
  return (
    <div className="space-y-8">
      <PageHeader title={t('chart_of_accounts')} />
      <ChartOfAccountsManager />
    </div>
  )
}
