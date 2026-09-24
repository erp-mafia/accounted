'use client'

import Image from 'next/image'
import { cn } from '@/lib/utils'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'

/**
 * The account mark of the Avstämning table: the bank's logo when the feed
 * carries one, otherwise a monogram of the account name (a manual balance
 * account shows its account class instead).
 */

function monogram(name: string): string {
  // Letters and digits only: "Företagskonto (SEK)" is FS, not "F(".
  const words = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function AccountLogo({ account, className }: { account: ReconciliationAccount; className?: string }) {
  if (account.logo_url) {
    return (
      <Image
        src={account.logo_url}
        alt=""
        width={20}
        height={20}
        className={cn('h-5 w-5 shrink-0 rounded-sm object-contain', className)}
        unoptimized
      />
    )
  }
  const label = account.kind === 'manual' ? account.account_number.slice(0, 2) : monogram(account.name)
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-secondary text-[11px] font-semibold tracking-tight text-secondary-foreground tabular-nums',
        className,
      )}
    >
      {label}
    </span>
  )
}
