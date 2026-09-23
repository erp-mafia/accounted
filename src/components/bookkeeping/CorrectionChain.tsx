'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import JournalEntryStatusBadge from '@/components/bookkeeping/JournalEntryStatusBadge'
import { formatDate, formatCurrency, cn } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { JournalEntry, JournalEntryLine } from '@/types'

interface Props {
  currentEntryId: string
  chain: JournalEntry[]
}

function useGetRole() {
  const t = useTranslations('journal_correction')
  return (entry: JournalEntry): string => {
    if (entry.source_type === 'storno') return t('role_storno')
    if (entry.source_type === 'correction') return t('role_correction')
    return t('role_original')
  }
}

function getTotal(entry: JournalEntry): number {
  const lines = (entry.lines || []) as JournalEntryLine[]
  return lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)
}

/**
 * The storno/rättelse chain as a flat chronological list: one hairline row
 * per verifikat (role, voucher, date, description, amount). The page owns the
 * kicker and puts the explanatory copy behind its "?" (convention 7), so this
 * renders no heading and no info box of its own.
 */
export default function CorrectionChain({ currentEntryId, chain }: Props) {
  const t = useTranslations('journal_correction')
  const getRole = useGetRole()
  if (chain.length === 0) return null

  // Combine current entry isn't in chain: chain is "other" entries
  // Sort chronologically
  const sorted = [...chain].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )

  return (
    <ul className="divide-y divide-border text-sm">
      {sorted.map((entry) => {
        const total = getTotal(entry)
        const isCurrent = entry.id === currentEntryId
        // A cancelled entry is residue from an aborted correction attempt:
        // it was voided before taking effect and its lines were removed, so
        // it always sums to 0,00. Without the status chip it renders exactly
        // like a live storno: dim it and say what it is. Live rows carry no
        // chip at all (chips mark exceptions); the role label says storno
        // or rättelse.
        const isCancelled = entry.status === 'cancelled'

        return (
          <li
            key={entry.id}
            className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 py-2', isCancelled && 'opacity-60')}
          >
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{getRole(entry)}</span>
            {isCurrent ? (
              <span className="tabular-nums">{formatVoucher(entry)}</span>
            ) : (
              <Link href={`/bookkeeping/${entry.id}`} className="tabular-nums hover:underline">
                {formatVoucher(entry)}
              </Link>
            )}
            <span className="tabular-nums text-muted-foreground">{formatDate(entry.entry_date)}</span>
            {entry.description && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.description}</span>
            )}
            {isCancelled && <JournalEntryStatusBadge entry={entry} />}
            {isCurrent && <Badge variant="outline">{t('current')}</Badge>}
            <span className="ml-auto tabular-nums text-muted-foreground">{formatCurrency(total)}</span>
          </li>
        )
      })}
    </ul>
  )
}
