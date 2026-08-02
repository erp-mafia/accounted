'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, Search } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { performCompanySwitch } from '@/lib/company/switch-client'
import { filterClientRows, type ClientOverviewRow } from '@/lib/clients/aggregate'

/**
 * The cockpit client list (WL-14): dry-table, urgency-sorted server-side,
 * free-text filter client-side. Entering a client is the WL-09 soft switch:
 * sets the active company and lands DIRECTLY on that company's overview via
 * performCompanySwitch (one full-page load to the target, no start-page
 * bounce). The way back is the Klienter nav entry, which needs no switch.
 */
export default function ClientsTable({ clients }: { clients: ClientOverviewRow[] }) {
  const t = useTranslations('clients')
  const { toast } = useToast()
  const [query, setQuery] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)

  const rows = useMemo(() => filterClientRows(clients, query), [clients, query])

  const handleEnter = async (companyId: string) => {
    if (pendingId) return
    setPendingId(companyId)
    const result = await performCompanySwitch(companyId, { destination: '/' })
    if (result?.error) {
      setPendingId(null)
      toast({ title: t('enter_failed'), variant: 'destructive' })
    }
  }

  if (clients.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('empty')}</p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 max-w-xs rounded-lg border border-border px-3 py-2">
        <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('filter_placeholder')}
          aria-label={t('filter_placeholder')}
          className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('col_company')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('col_unbooked')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('col_inbox')}</th>
              <th className={TH_CLASS}>{t('col_next_deadline')}</th>
              <th className={TH_CLASS}>{t('col_last_booked')}</th>
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {rows.length === 0 && (
              <tr>
                <td className={cn(TD_CLASS, 'text-muted-foreground')} colSpan={5}>
                  {t('no_matches')}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.companyId}
                onClick={() => void handleEnter(row.companyId)}
                className={cn(
                  'cursor-pointer transition-colors duration-150 hover:bg-secondary/35',
                  pendingId && pendingId !== row.companyId && 'opacity-50',
                )}
              >
                <td className={TD_CLASS}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleEnter(row.companyId)
                    }}
                    disabled={pendingId !== null}
                    className="flex items-center gap-2 text-left"
                  >
                    <span className="font-medium text-foreground">{row.name}</span>
                    {row.orgNumber && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {row.orgNumber}
                      </span>
                    )}
                    {pendingId === row.companyId && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </button>
                </td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                  {row.unbookedCount > 0 ? (
                    row.unbookedCount
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                  {row.inboxCount > 0 ? (
                    row.inboxCount
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className={TD_CLASS}>
                  {row.nextDeadline ? (
                    <span className="flex items-center gap-2">
                      {/* Chips mark exceptions: only overdue/action_needed
                          deviate; an ordinary upcoming deadline is muted text. */}
                      {row.nextDeadline.urgency === 'overdue' && (
                        <Badge variant="destructive">{t('deadline_overdue')}</Badge>
                      )}
                      {row.nextDeadline.urgency === 'action_needed' && (
                        <Badge variant="warning">{t('deadline_action_needed')}</Badge>
                      )}
                      <span
                        className={cn(
                          'truncate',
                          row.nextDeadline.urgency === 'upcoming' && 'text-muted-foreground',
                        )}
                      >
                        {row.nextDeadline.title}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {formatDate(row.nextDeadline.dueDate)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className={cn(TD_CLASS, 'tabular-nums')}>
                  {row.lastBookedDate ? (
                    <span className="text-muted-foreground">
                      {formatDate(row.lastBookedDate)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t('never_booked')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
