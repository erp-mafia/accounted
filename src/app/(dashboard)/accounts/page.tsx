import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import AccountsOverview from '@/components/accounts/AccountsOverview'
import AddAccountMenu from '@/components/accounts/AddAccountMenu'

export const dynamic = 'force-dynamic'

/**
 * Konton: every account with an outside truth on one list, and the way into
 * each account's reconciliation (founder decision 2026-10-18: the Avstämning
 * list merged into this one; /reconciliation without an account redirects
 * here, next.config.ts). ?autorun=1 is the old bankavstämning deep link from
 * the transactions inbox, carried on to the bank account a row opens.
 */
export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ autorun?: string }> }) {
  const [t, query] = await Promise.all([getTranslations('accounts_v2'), searchParams])
  return (
    <>
      <PageHeader title={t('title')} help={<HelpPopover>{t('help')}</HelpPopover>} action={<AddAccountMenu />} />
      <AccountsOverview autorun={query.autorun === '1'} />
    </>
  )
}
