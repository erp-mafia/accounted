'use client'

import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import { cn } from '@/lib/utils'

/**
 * How a counterpart books, said the way the Transaktioner category chip
 * says it: the account's name and the number muted after it, on the quiet
 * wash (Stil v3: no hue dots; the name carries it). A bare "5420" nub told
 * the person nothing.
 */
export function AccountChip({ account, name, className }: { account: string | null; name?: string | null; className?: string }) {
  if (!account) return <span className="text-muted-foreground">·</span>
  // The company's own name for the account when the page has it (custom
  // accounts included); the BAS name otherwise; nothing when the map only
  // echoes the number back, so the chip never reads "6540 6540".
  const bas = getAccountName(account)
  const shown = (name && name.trim()) || (bas !== account ? bas : '')
  return (
    <span className={cn('inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-md bg-secondary/60 px-2 text-xs', className)}>
      <span className="truncate">{shown || account}</span>
      {shown && <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{account}</span>}
    </span>
  )
}
