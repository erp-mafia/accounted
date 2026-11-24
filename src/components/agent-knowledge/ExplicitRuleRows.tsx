'use client'

import { useTranslations } from 'next-intl'
import { AccountNumber } from '@/components/ui/account-number'
import type { ExplicitRule } from '@/lib/agent-context/ledger-context'
import { vatLabel } from '@/lib/agent-context/vat-labels'

/**
 * The company's explicit rules, one row each: the rule's name, what it
 * matches, the account with its name, the VAT treatment and that it is a
 * rule. The one drawing of that row: the bookkeeping profile lists the rules
 * with it, and so does Bokföringsregler for a company with the agent
 * picture on. Each host draws its own heading.
 */
export function ExplicitRuleRows({ rules }: { rules: readonly ExplicitRule[] }) {
  const t = useTranslations('agentKnowledge')
  return (
    <>
      {rules.map((r, i) => {
        const vat = vatLabel(r.vat_treatment)
        return (
          <div key={r.rule_name + r.match + i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b-hairline px-1 py-3">
            <span className="text-sm">{r.rule_name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{r.match}</span>
            <span className="flex shrink-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              {r.account_number ? <AccountNumber number={r.account_number} showName size="sm" /> : <span>-</span>}
              {vat && <span>· {vat}</span>}
              <span>· {t('src_rule')}</span>
            </span>
          </div>
        )
      })}
    </>
  )
}
