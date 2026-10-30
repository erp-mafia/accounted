import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import RulesList from '@/components/rules/RulesList'
import BookingBlocks from '@/components/rules/BookingBlocks'

export const dynamic = 'force-dynamic'

/**
 * Regler (UI v2 PR 5): the company's counterparty rules on the trust
 * ladder. Reachable from the sidebar
 * (Transaktioner › Regler); the v1 settings panel keeps working beside it.
 * Below them, Spärrar (accounted#130): what is never booked without a
 * person's review.
 */
export default async function RulesPage() {
  const t = await getTranslations('rules')
  return (
    <>
      <PageHeader title={t('title')} help={<HelpPopover>{t('help')}</HelpPopover>} />
      <div className="space-y-8">
        <RulesList />
        <BookingBlocks />
      </div>
    </>
  )
}
