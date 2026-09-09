'use client'

import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import { HUE_DOT_CLASS, accountHue } from '@/lib/bookkeeping/template-group-colors'
import { cn } from '@/lib/utils'

/**
 * How a counterpart books, said the way the Transaktioner category chip
 * says it: a hue dot for the account's family, the account's name, and the
 * number muted after it. A bare "5420" nub told the person nothing.
 */
export function AccountChip({ account, className }: { account: string | null; className?: string }) {
  if (!account) return <span className="text-muted-foreground">·</span>
  const name = getAccountName(account)
  return (
    <span className={cn('inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs', className)}>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', HUE_DOT_CLASS[accountHue(account)])} aria-hidden />
      <span className="truncate">{name || account}</span>
      {name && <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{account}</span>}
    </span>
  )
}
