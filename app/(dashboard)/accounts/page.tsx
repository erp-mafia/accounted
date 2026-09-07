import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import AccountsOverview from '@/components/accounts/AccountsOverview'

export const dynamic = 'force-dynamic'

/**
 * Konton (UI v2 PR 8): bank accounts and the skattekonto on one page, with
 * last read, sign-off date and rows to review. Reachable from the v2 sidebar
 * (Konton › Översikt); the reconciliation workspace does the work.
 */
export default async function AccountsPage() {
  const t = await getTranslations('accounts_v2')
  return (
    <>
      <PageHeader title={t('title')} help={<HelpPopover>{t('help')}</HelpPopover>} />
      <AccountsOverview />
    </>
  )
}
