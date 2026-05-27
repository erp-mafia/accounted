'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Info } from 'lucide-react'
import JournalEntryStatusBadge from '@/components/bookkeeping/JournalEntryStatusBadge'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { JournalEntry, JournalEntryLine } from '@/types'

interface Props {
  currentEntryId: string
  chain: JournalEntry[]
}

function useGetRole() {
  const t = useTranslations('journal_correction')
  return (entry: JournalEntry): { label: string; color: string } => {
    if (entry.source_type === 'storno') {
      return { label: t('role_storno'), color: 'bg-destructive' }
    }
    if (entry.source_type === 'correction') {
      return { label: t('role_correction'), color: 'bg-primary' }
    }
    return { label: t('role_original'), color: 'bg-muted-foreground' }
  }
}

function getTotal(entry: JournalEntry): number {
  const lines = (entry.lines || []) as JournalEntryLine[]
  return lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)
}

export default function CorrectionChain({ currentEntryId, chain }: Props) {
  const t = useTranslations('journal_correction')
  const getRole = useGetRole()
  if (chain.length === 0) return null

  // Combine current entry isn't in chain — chain is "other" entries
  // Sort chronologically
  const sorted = [...chain].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{t('title')}</h3>

      <div className="rounded-lg bg-muted/50 border p-3 flex gap-2 text-sm text-muted-foreground">
        <Info className="h-4 w-4 shrink-0 mt-0.5" />
        <p>{t('info')}</p>
      </div>

      <div className="relative space-y-0">
        {/* Vertical line connecting nodes */}
        <div className="absolute left-[7px] top-3 bottom-3 w-px bg-border" />

        {sorted.map((entry) => {
          const role = getRole(entry)
          const total = getTotal(entry)
          const isCurrent = entry.id === currentEntryId

          return (
            <Link
              key={entry.id}
              href={`/bookkeeping/${entry.id}`}
              className="block"
            >
              <div className={`relative pl-7 py-2 rounded-md transition-colors hover:bg-muted/50 ${isCurrent ? 'bg-muted/30' : ''}`}>
                {/* Timeline dot */}
                <div className={`absolute left-0.5 top-[18px] h-3 w-3 rounded-full border-2 border-background ${role.color}`} />

                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-muted-foreground">{role.label}</span>
                  <span className="font-mono text-sm">
                    {formatVoucher(entry)}
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">{formatDate(entry.entry_date)}</span>
                  <JournalEntryStatusBadge entry={entry} showStatus={false} />
                  {isCurrent && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {t('current')}
                    </Badge>
                  )}
                  <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                    {total.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} kr
                  </span>
                </div>
                {entry.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{entry.description}</p>
                )}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
