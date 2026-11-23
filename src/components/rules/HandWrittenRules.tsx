'use client'

import { useTranslations } from 'next-intl'
import { ExplicitRuleRows } from '@/components/agent-knowledge/ExplicitRuleRows'
import { HelpPopover } from '@/components/ui/help-popover'
import type { ExplicitRule } from '@/lib/agent-context/ledger-context'

/**
 * The rules the company set itself on Bokföringsregler, for a company with
 * the agent picture on: under the list of counterparty rules, with the
 * heading and the help the bookkeeping profile gives its explicit rules (the
 * agentKnowledge messages) and the profile's own row (ExplicitRuleRows). The
 * page reads the rules, never a row a booking learned, and hands them in;
 * with none there is no section.
 */
export default function HandWrittenRules({ rules }: { rules: readonly ExplicitRule[] }) {
  const t = useTranslations('agentKnowledge')
  if (rules.length === 0) return null
  return (
    <section className="stagger-enter space-y-3" aria-labelledby="hand-written-rules-title">
      <div className="flex min-h-7 items-center gap-2">
        <h2 id="hand-written-rules-title" className="text-[15px] font-medium text-strong">
          {t('rules_title')}
        </h2>
        <HelpPopover className="shrink-0">{t('rules_description')}</HelpPopover>
      </div>
      <div>
        <ExplicitRuleRows rules={rules} />
      </div>
    </section>
  )
}
