import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import RulesList from '@/components/rules/RulesList'

export const dynamic = 'force-dynamic'

/**
 * Regler (UI v2 PR 5): the company's counterparty rules on the trust
 * ladder. Reachable from the sidebar
 * (Transaktioner › Regler); the v1 settings panel keeps working beside it.
 */
export default async function RulesPage() {
  const t = await getTranslations('rules')
  return (
    <>
      <PageHeader title={t('title')} help={<HelpPopover>{t('help')}</HelpPopover>} />
      <RulesList />
    </>
  )
}
