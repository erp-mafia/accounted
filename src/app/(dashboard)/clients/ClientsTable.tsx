'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Loader2, Search } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { performCompanySwitch } from '@/lib/company/switch-client'
import { filterClientRows, type ClientBankSwitch, type ClientOverviewRow } from '@/lib/clients/aggregate'

/** The bank connection switch campaign as the page passes it: on with its deadline, or null. */
export interface BankSwitchCampaignView {
  deadline: string
  passed: boolean
}

interface ClientsTableProps {
  clients: ClientOverviewRow[]
  /** Null while the campaign is off: no column, no nudges. */
  bankSwitchCampaign?: BankSwitchCampaignView | null
}

type NudgeTarget = { kind: 'one'; row: ClientOverviewRow } | { kind: 'all'; count: number }

/**
 * The cockpit client list (WL-14): dry-table, urgency-sorted server-side,
 * free-text filter client-side. Entering a client is the WL-09 soft switch:
 * sets the active company and lands DIRECTLY on that company's overview via
 * performCompanySwitch (one full-page load to the target, no start-page
 * bounce). The way back is the Klienter nav entry, which needs no switch.
 *
 * Each row also opens that client's own settings (Företag, where Radera
 * företag lives for owners) through the same switch: the user menu's
 * Inställningar in the cockpit is the account's, never a company's, since
 * company settings are edited from inside the company (crm#1237).
 *
 * While the bank connection switch campaign is on, a Bankkoppling column
 * says where each client stands (a chip only where the client deviates:
 * byt senast, stoppad) and the byrå can ask one client, or every client that
 * has not switched, to connect the bank: a mail to the client's own owners
 * and admins (POST /api/clients/bank-switch/remind), since the switch is
 * signed with the client's BankID, not the byrå's.
 */
export default function ClientsTable({ clients, bankSwitchCampaign = null }: ClientsTableProps) {
  const t = useTranslations('clients')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [query, setQuery] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [nudge, setNudge] = useState<NudgeTarget | null>(null)

  const rows = useMemo(() => filterClientRows(clients, query), [clients, query])
  const showBankSwitch = bankSwitchCampaign !== null
  const notSwitched = useMemo(
    () => clients.filter((c) => c.bankSwitch?.state === 'pending' || c.bankSwitch?.state === 'stopped'),
    [clients],
  )

  const handleEnter = async (companyId: string, destination: '/' | '/settings/company' = '/') => {
    if (pendingId) return
    setPendingId(companyId)
    const result = await performCompanySwitch(companyId, { destination })
    if (result?.error) {
      setPendingId(null)
      toast({ title: t('enter_failed'), variant: 'destructive' })
    }
  }

  async function sendNudge(target: NudgeTarget) {
    const res = await fetch('/api/clients/bank-switch/remind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target.kind === 'one' ? { company_id: target.row.companyId } : { all: true }),
    })
    const body = (await res.json().catch(() => ({}))) as { data?: { sent?: number; recently_sent?: number; recipients?: number }; error?: unknown }
    if (!res.ok || body.error) {
      toast({ title: t('bank_switch_nudge_failed'), description: getErrorMessage(body, { locale, statusCode: res.status }), variant: 'destructive' })
      throw new Error('nudge failed')
    }
    if (target.kind === 'one') {
      toast({ title: t('bank_switch_nudge_sent', { client: target.row.name }) })
    } else {
      toast({ title: t('bank_switch_bulk_sent', { sent: body.data?.sent ?? 0, recent: body.data?.recently_sent ?? 0 }) })
    }
  }

  if (clients.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('empty')}</p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2 max-w-xs flex-1 rounded-lg border border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('filter_placeholder')}
            aria-label={t('filter_placeholder')}
            className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
        </div>
        {showBankSwitch && notSwitched.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setNudge({ kind: 'all', count: notSwitched.length })}>
            {t('bank_switch_bulk', { count: notSwitched.length })}
          </Button>
        )}
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
              {showBankSwitch && <th className={TH_CLASS}>{t('col_bank_switch')}</th>}
              <th className={TH_CLASS}>
                <span className="sr-only">{t('col_actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {rows.length === 0 && (
              <tr>
                <td className={cn(TD_CLASS, 'text-muted-foreground')} colSpan={showBankSwitch ? 7 : 6}>
                  {t('no_matches')}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.companyId}
                onClick={() => void handleEnter(row.companyId)}
                className={cn(
                  'group cursor-pointer transition-colors duration-150 hover:bg-secondary/35',
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
                {showBankSwitch && (
                  <td className={TD_CLASS}>
                    <BankSwitchCell
                      value={row.bankSwitch ?? null}
                      onNudge={() => setNudge({ kind: 'one', row })}
                      nudgeLabel={t('bank_switch_nudge')}
                      labels={{
                        done: t('bank_switch_done'),
                        fileImport: t('bank_switch_file_import'),
                        stopped: t('bank_switch_stopped'),
                        by: (date: string) => t('bank_switch_by', { date }),
                      }}
                    />
                  </td>
                )}
                <td className={cn(TD_CLASS, 'text-right')}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleEnter(row.companyId, '/settings/company')
                    }}
                    disabled={pendingId !== null}
                    aria-label={t('company_settings_aria', { client: row.name })}
                    className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS, 'whitespace-nowrap')}
                  >
                    {t('company_settings')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={nudge !== null}
        onOpenChange={(open) => {
          if (!open) setNudge(null)
        }}
        title={nudge?.kind === 'one' ? t('bank_switch_nudge_title', { client: nudge.row.name }) : t('bank_switch_bulk_title', { count: nudge?.count ?? 0 })}
        description={nudge?.kind === 'one' ? t('bank_switch_nudge_description') : t('bank_switch_bulk_description')}
        confirmLabel={nudge?.kind === 'one' ? t('bank_switch_nudge_confirm') : t('bank_switch_bulk_confirm')}
        onConfirm={async () => {
          if (nudge) await sendNudge(nudge)
        }}
      />
    </div>
  )
}

interface BankSwitchCellProps {
  value: ClientBankSwitch | null
  onNudge: () => void
  nudgeLabel: string
  labels: { done: string; fileImport: string; stopped: string; by: (date: string) => string }
}

/**
 * One client's campaign state. Normal states are muted text (done, file
 * import, no bank feed at all); the two that need the client to act carry a
 * chip and the nudge button, which stops the row's click-through.
 */
function BankSwitchCell({ value, onNudge, nudgeLabel, labels }: BankSwitchCellProps) {
  if (!value) return <span className="text-muted-foreground">-</span>
  if (value.state === 'done') return <span className="text-muted-foreground">{labels.done}</span>
  if (value.state === 'uncovered') {
    return (
      <span className="text-muted-foreground">
        {labels.fileImport}
        {value.banks.length > 0 && <span> · {value.banks.join(', ')}</span>}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-2">
      {value.state === 'stopped' ? (
        <Badge variant="destructive">{labels.stopped}</Badge>
      ) : (
        <Badge variant="warning">{labels.by(formatDate(value.deadline))}</Badge>
      )}
      {value.banks.length > 0 && <span className="truncate text-muted-foreground">{value.banks.join(', ')}</span>}
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto text-muted-foreground hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation()
          onNudge()
        }}
      >
        {nudgeLabel}
      </Button>
    </span>
  )
}
