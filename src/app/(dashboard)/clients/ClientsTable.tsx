'use client'

import { useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PaperAirplaneIcon, SpinnerIcon } from '@/components/icons'
import { ToolbarSearch, TOOLBAR_SEARCH_END_CLASS } from '@/components/ui/toolbar-search'
import { cn, formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { companySwitchErrorKey, performCompanySwitch } from '@/lib/company/switch-client'
import { filterClientRows, type ClientBankSwitch, type ClientOverviewRow } from '@/lib/clients/aggregate'
import type { AttestQueue } from '@/lib/supplier-invoices/attest-queues'
import { CLIENT_NUMBER_MAX_LENGTH } from '@/lib/clients/client-number'

/** The bank connection switch campaign as the page passes it: on with its deadline, or null. */
export interface BankSwitchCampaignView {
  deadline: string
  passed: boolean
}

interface ClientsTableProps {
  clients: ClientOverviewRow[]
  /** Null while the campaign is off: no column, no nudges. */
  bankSwitchCampaign?: BankSwitchCampaignView | null
  /** The byrå's owners and admins edit the customer number in place; members only read it. */
  canEditClientNumber?: boolean
  /** Owners and admins have Nytt klientbolag in the header; the empty list points members elsewhere. */
  canCreate?: boolean
}

type NudgeTarget = { kind: 'one'; row: ClientOverviewRow } | { kind: 'all'; count: number }

/**
 * The cockpit client list (WL-14): dry-table, urgency-sorted server-side,
 * free-text filter client-side. Entering a client is the WL-09 soft switch:
 * sets the active company and lands DIRECTLY on the person's start page in
 * that company (Att göra unless they chose another) via performCompanySwitch
 * (one full-page load to the target, no bounce). The way back is the
 * Klienter nav entry, which needs no switch.
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
 *
 * The first column is the byrå's own customer number for each client
 * (crm#1279): owners and admins click it to set, change or clear it in place
 * (PUT /api/clients/:companyId/client-number), so a byrå fills its whole
 * list without entering any client; the filter matches it too. The column
 * hides for a plain member while no client has a number.
 *
 * Where any client attests its supplier invoices (the attest policy), two
 * columns say what waits on whom: Väntar på kund (invoices the client has not
 * attested) and Redo att betala (still owed and not held by the policy: what
 * the client's Att göra counts as to pay, less what Att göra shows as a failed
 * payment), each with the nearest due
 * date and the fallen-due ones marked. A count enters the client
 * on the supplier invoice list's matching tab. Same queues as the client's
 * own Att göra row (lib/supplier-invoices/attest-queues.ts).
 */
export default function ClientsTable({ clients, bankSwitchCampaign = null, canEditClientNumber = false, canCreate = false }: ClientsTableProps) {
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
  const tSwitcher = useTranslations('company_switcher')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [query, setQuery] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [nudge, setNudge] = useState<NudgeTarget | null>(null)
  // Numbers saved on this page, over the server-rendered rows.
  const [savedNumbers, setSavedNumbers] = useState<Record<string, string | null>>({})

  const withNumbers = useMemo(
    () => clients.map((c) => (c.companyId in savedNumbers ? { ...c, clientNumber: savedNumbers[c.companyId] } : c)),
    [clients, savedNumbers],
  )
  const rows = useMemo(() => filterClientRows(withNumbers, query), [withNumbers, query])
  const showClientNumber = canEditClientNumber || withNumbers.some((c) => c.clientNumber)
  const showBankSwitch = bankSwitchCampaign !== null
  const showAttest = withNumbers.some((c) => c.attest)
  const columnCount = 6 + (showClientNumber ? 1 : 0) + (showBankSwitch ? 1 : 0) + (showAttest ? 2 : 0)
  const notSwitched = useMemo(
    () => clients.filter((c) => c.bankSwitch?.state === 'pending' || c.bankSwitch?.state === 'stopped'),
    [clients],
  )

  // Without a destination the client opens on the byrå person's start page there (lib/company/start-page.ts).
  const handleEnter = async (companyId: string, destination?: string) => {
    if (pendingId) return
    setPendingId(companyId)
    const result = await performCompanySwitch(companyId, { destination })
    if (result?.error) {
      setPendingId(null)
      // The same sentences as the company switcher: a paused company or a
      // lost membership says so, not only that the client did not open.
      toast({ title: tSwitcher(companySwitchErrorKey(result.error)), variant: 'destructive' })
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

  async function saveClientNumber(row: ClientOverviewRow, value: string | null): Promise<boolean> {
    try {
      const res = await fetch(`/api/clients/${row.companyId}/client-number`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_number: value }),
      })
      const body = (await res.json().catch(() => ({}))) as { data?: { client_number: string | null }; error?: unknown }
      if (!res.ok || body.error) {
        toast({ title: t('client_number_save_failed'), description: getErrorMessage(body, { locale, statusCode: res.status }), variant: 'destructive' })
        return false
      }
      setSavedNumbers((prev) => ({ ...prev, [row.companyId]: body.data?.client_number ?? null }))
      return true
    } catch (error) {
      toast({ title: t('client_number_save_failed'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
      return false
    }
  }

  if (clients.length === 0) {
    return <EmptyState title={canCreate ? t('empty') : t('empty_member')} />
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: the bulk action first, search at the right end (V7 list toolbars). */}
      <div className="flex flex-wrap items-center gap-2">
        {showBankSwitch && notSwitched.length > 0 && (
          <Button variant="outline" size="toolbar" onClick={() => setNudge({ kind: 'all', count: notSwitched.length })}>
            <PaperAirplaneIcon className="h-4 w-4" />
            {t('bank_switch_bulk', { count: notSwitched.length })}
          </Button>
        )}
        <ToolbarSearch
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('filter_placeholder')}
          aria-label={t('filter_placeholder')}
          containerClassName={TOOLBAR_SEARCH_END_CLASS}
        />
      </div>

      <div className="-mx-2 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {showClientNumber && <th className={TH_CLASS}>{t('col_client_number')}</th>}
              <th className={TH_CLASS}>{t('col_company')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('col_unbooked')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('col_inbox')}</th>
              {showAttest && <th className={TH_CLASS}>{t('col_attest_waiting')}</th>}
              {showAttest && <th className={TH_CLASS}>{t('col_attest_ready')}</th>}
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
                <td className={cn(TD_CLASS, 'text-muted-foreground')} colSpan={columnCount}>
                  <span className="flex flex-wrap items-center gap-x-3">
                    <span>{t('no_matches')}</span>
                    <Button variant="link" onClick={() => setQuery('')}>
                      {tCommon('clear_search')}
                    </Button>
                  </span>
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
                {showClientNumber && (
                  <td
                    className={cn(TD_CLASS, 'whitespace-nowrap')}
                    // The cell edits the number; a near miss must not enter the client.
                    onClick={canEditClientNumber ? (e) => e.stopPropagation() : undefined}
                  >
                    <ClientNumberCell
                      value={row.clientNumber}
                      canEdit={canEditClientNumber}
                      editLabel={t('client_number_edit_aria', { client: row.name })}
                      onSave={(value) => saveClientNumber(row, value)}
                    />
                  </td>
                )}
                <td className={TD_CLASS}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleEnter(row.companyId)
                    }}
                    disabled={pendingId !== null}
                    className="flex items-center gap-2 whitespace-nowrap text-left"
                  >
                    <span className="font-medium text-foreground">{row.name}</span>
                    {row.orgNumber && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {row.orgNumber}
                      </span>
                    )}
                    {pendingId === row.companyId && (
                      <SpinnerIcon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
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
                {showAttest && (
                  <td className={TD_CLASS}>
                    <AttestQueueCell
                      value={row.attest ? row.attest.waiting : null}
                      disabled={pendingId !== null}
                      ariaLabel={t('attest_waiting_aria', { client: row.name })}
                      overdueLabel={(count: number) => t('attest_overdue', { count })}
                      onOpen={() => void handleEnter(row.companyId, '/supplier-invoices?tab=registered')}
                    />
                  </td>
                )}
                {showAttest && (
                  <td className={TD_CLASS}>
                    <AttestQueueCell
                      value={row.attest ? row.attest.ready : null}
                      disabled={pendingId !== null}
                      ariaLabel={t('attest_ready_aria', { client: row.name })}
                      overdueLabel={(count: number) => t('attest_overdue', { count })}
                      onOpen={() => void handleEnter(row.companyId, '/supplier-invoices?tab=to_pay')}
                    />
                  </td>
                )}
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
                      <span className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatDate(row.nextDeadline.dueDate)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className={cn(TD_CLASS, 'date-figures')}>
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

interface AttestQueueCellProps {
  /** Null: the client has no attest step, shown as a dash. */
  value: AttestQueue | null
  disabled: boolean
  ariaLabel: string
  overdueLabel: (count: number) => string
  onOpen: () => void
}

/**
 * One attest queue of a client: the count, the nearest due date muted
 * beside it, and a chip when some have fallen due. A count opens the client
 * on the matching supplier invoice tab; zero is a muted 0, no attest step a
 * dash.
 */
function AttestQueueCell({ value, disabled, ariaLabel, overdueLabel, onOpen }: AttestQueueCellProps) {
  if (!value) return <span className="text-muted-foreground">-</span>
  if (value.count === 0) return <span className="text-muted-foreground tabular-nums">0</span>
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      className="-mx-1 flex items-center gap-2 rounded-sm px-1 text-left transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span className="tabular-nums text-foreground">{value.count}</span>
      {value.overdue > 0 && <Badge variant="warning">{overdueLabel(value.overdue)}</Badge>}
      {value.next_due && <span className="text-muted-foreground tabular-nums">{formatDate(value.next_due)}</span>}
    </button>
  )
}

interface ClientNumberCellProps {
  value: string | null
  canEdit: boolean
  editLabel: string
  /** Resolves true once saved; false keeps the field open (the caller toasts why). */
  onSave: (value: string | null) => Promise<boolean>
}

/**
 * The byrå's customer number: muted "-" when unset. For owners and admins
 * the value is a button that turns into a field in place; Enter or leaving
 * the field saves, Escape restores. An unchanged value saves nothing.
 */
function ClientNumberCell({ value, canEdit, editLabel, onSave }: ClientNumberCellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // Enter commits and closes the field; the blur that may follow must not commit again.
  const settled = useRef(false)

  const display = value ? (
    <span className="tabular-nums text-foreground">{value}</span>
  ) : (
    <span className="text-muted-foreground">-</span>
  )
  if (!canEdit) return display

  const open = () => {
    settled.current = false
    setDraft(value ?? '')
    setEditing(true)
  }

  const commit = async () => {
    if (settled.current) return
    const next = draft.trim()
    if (next === (value ?? '')) {
      settled.current = true
      setEditing(false)
      return
    }
    settled.current = true
    setSaving(true)
    const ok = await onSave(next || null)
    setSaving(false)
    if (ok) setEditing(false)
    else settled.current = false
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        aria-label={editLabel}
        title={editLabel}
        className="-mx-1 rounded-sm px-1 text-left transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {display}
      </button>
    )
  }

  return (
    <input
      autoFocus
      value={draft}
      maxLength={CLIENT_NUMBER_MAX_LENGTH}
      disabled={saving}
      aria-label={editLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          settled.current = true
          setEditing(false)
        }
      }}
      className="-my-1 h-7 w-24 rounded-lg px-2 text-[13px] tabular-nums transition-colors duration-150 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/20 disabled:opacity-50 bg-control shadow-raised"
    />
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
