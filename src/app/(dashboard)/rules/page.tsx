import { getLocale, getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import RulesList from '@/components/rules/RulesList'
import BookingBlocks from '@/components/rules/BookingBlocks'
import HandWrittenRules from '@/components/rules/HandWrittenRules'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { readWrittenRules, type ExplicitRule } from '@/lib/agent-context/ledger-context'
import { profileLine, readProfileFacts } from '@/lib/agent-context/profile-line'
import { createLogger } from '@/lib/logger'
import { getDashboardAuthContext, getDashboardCompanyId, redirectInvoicerOffPage } from '../request-context'

export const dynamic = 'force-dynamic'

const log = createLogger('rules/page')

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
 * each left out when the company has no value for it. Under the list, the
 * rules the company set itself (lib/agent-context/ledger-context.ts
 * readWrittenRules: the explicit rules of the bookkeeping profile without
 * the rows a booking learned, for every company), under the profile's own
 * heading and in its own row; a company with none has no such section.
 * /wiki?view=map leads here for such a company. Every other company gets the
 * page without either, and nothing is read for them.
 */
export default async function RulesPage() {
  const t = await getTranslations('rules')
  const { line, rules } = await pictureParts((key, values) => t(key, values))
  const list = line ? (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{line}</p>
      <RulesList />
    </div>
  ) : (
    <RulesList />
  )
  return (
    <>
      <PageHeader title={t('title')} help={<HelpPopover>{t('help')}</HelpPopover>} />
      {rules.length > 0 ? (
        <div className="space-y-8">
          {list}
          <HandWrittenRules rules={rules} />
          <BookingBlocks />
        </div>
      ) : (
        <div className="space-y-8">
          {list}
          <BookingBlocks />
        </div>
      )}
    </>
  )
}

/**
 * What the page adds for a company with the agent picture on: the sentence
 * (null when the company has none of its parts) and the rules the company
 * set itself. Every other company gets neither, and nothing is read. The
 * reads go through the caller's own client, filtered by the company. Rules
 * that cannot be read are logged and left out: the page is then as for a
 * company with none.
 */
async function pictureParts(t: (key: string, values?: Record<string, string | number>) => string): Promise<{ line: string | null; rules: ExplicitRule[] }> {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isAgentPictureEnabled(companyId)) return { line: null, rules: [] }
  // An invoicer goes to the invoices before the reads below.
  const [{ supabase }, locale] = await Promise.all([getDashboardAuthContext(), getLocale(), redirectInvoicerOffPage()])
  const [facts, rules] = await Promise.all([
    readProfileFacts(supabase, companyId),
    readWrittenRules(supabase, companyId).catch((error: unknown) => {
      log.warn('written rules read failed', { companyId, error: error instanceof Error ? error.message : String(error) })
      return [] as ExplicitRule[]
    }),
  ])
  return { line: profileLine(facts, t, locale), rules }
}
