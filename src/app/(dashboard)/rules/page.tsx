import { getLocale, getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import RulesList from '@/components/rules/RulesList'
import BookingBlocks from '@/components/rules/BookingBlocks'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { profileLine, readProfileFacts } from '@/lib/agent-context/profile-line'
import { getDashboardAuthContext, getDashboardCompanyId, redirectInvoicerOffPage } from '../request-context'

export const dynamic = 'force-dynamic'

/**
 * Bokföringsregler (UI v2 PR 5): the company's counterparty rules on the
 * trust ladder. Reachable from the sidebar
 * (Agenter › Bokföringsregler); the v1 settings panel keeps working beside it.
 * Below them, Spärrar (accounted#130): what is never booked without a
 * person's review.
 *
 * For a company with the agent picture on (AGENT_PICTURE_COMPANY_IDS) one
 * sentence above the list says how the company books: its accounting method,
 * its VAT period and its voucher series (lib/agent-context/profile-line.ts),
 * each left out when the company has no value for it. /wiki?view=map leads
 * here for such a company. Every other company gets the page without it, and
 * nothing is read for the sentence.
 */
export default async function RulesPage() {
  const t = await getTranslations('rules')
  const line = await pictureProfileLine((key, values) => t(key, values))
  return (
    <>
      <PageHeader title={t('title')} help={<HelpPopover>{t('help')}</HelpPopover>} />
      <div className="space-y-8">
        {line ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{line}</p>
            <RulesList />
          </div>
        ) : (
          <RulesList />
        )}
        <BookingBlocks />
      </div>
    </>
  )
}

/** The sentence for a company with the agent picture on; null for every other company and when the company has none of its parts. */
async function pictureProfileLine(t: (key: string, values?: Record<string, string | number>) => string): Promise<string | null> {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isAgentPictureEnabled(companyId)) return null
  // An invoicer goes to the invoices before the reads below.
  const [{ supabase }, locale] = await Promise.all([getDashboardAuthContext(), getLocale(), redirectInvoicerOffPage()])
  return profileLine(await readProfileFacts(supabase, companyId), t, locale)
}
