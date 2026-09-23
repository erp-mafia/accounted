'use client'

import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import { HUE_DOT_CLASS, accountHue } from '@/lib/bookkeeping/template-group-colors'
import { cn } from '@/lib/utils'

/**
 * How a counterpart books, said the way the Transaktioner category chip
 * says it: a hue dot for the account's family, the account's name, and the
 * number muted after it. A bare "5420" nub told the person nothing.
 */
export function AccountChip({ account, name, className }: { account: string | null; name?: string | null; className?: string }) {
  if (!account) return <span className="text-muted-foreground">·</span>
  // The company's own name for the account when the page has it (custom
  // accounts included); the BAS name otherwise; nothing when the map only
  // echoes the number back, so the chip never reads "6540 6540".
  const bas = getAccountName(account)
  const shown = (name && name.trim()) || (bas !== account ? bas : '')
  return (
    <span className={cn('inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs', className)}>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', HUE_DOT_CLASS[accountHue(account)])} aria-hidden />
      <span className="truncate">{shown || account}</span>
      {shown && <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{account}</span>}
    </span>
  )
}
