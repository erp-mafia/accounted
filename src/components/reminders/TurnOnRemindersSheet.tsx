'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverFooter, SlideOverHeader } from '@/components/ui/slide-over'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { useBranding } from '@/lib/branding/brand-context'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useFormat } from '@/lib/hooks/use-format'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import type { PickableInvoice, ReminderOverview } from '@/lib/reminders/overview'
import { REMINDER_LEVELS, type ReminderLevel } from '@/lib/reminders/policy'
import {
  checkReminderDays,
  mergeSendResults,
  reminderDaysChanged,
  reminderDaysInput,
  type PickedSendResult,
  type ReminderDaysInput,
} from '@/lib/reminders/turn-on'
import { formatCurrency } from '@/lib/utils'
import { AutomaticRemindersControl } from './AutomaticRemindersControl'
import { ReminderMailPreview, useReminderPreview } from './ReminderMailPreview'
import { ReminderSendResults } from './ReminderSendResults'
import { errorLocale, fetchReminderOverview, saveReminderSettings, sendPickedReminders } from './reminders-client'

const SECTION_HEADING_CLASS = 'text-[11px] font-medium uppercase tracking-wider text-muted-foreground'

type Busy = 'turn_on' | 'days' | 'turn_off' | 'send' | null

interface TurnOnRemindersSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The overview after reminders went on or off or the days were saved, so the page's entry point follows. */
  onChanged?: (overview: ReminderOverview) => void
}

/**
 * Turning reminders on, in a right slide-over (accounted#104, phase 3): what
 * happens, the three days, the mail at each level, and the honest
 * consequence that only invoices sent from today join by themselves. The
 * overdue invoices sent from Accounted before that are offered once, each
 * unticked: the person picks which get a first reminder now. Once on, the
 * same sheet shows since when, saves the days and turns reminders off.
 * Renders nothing while REMINDERS_SENDING_ENABLED is false.
 */
export function TurnOnRemindersSheet(props: TurnOnRemindersSheetProps) {
  if (!REMINDERS_SENDING_ENABLED) return null
  return <TurnOnRemindersSheetContent {...props} />
}

function TurnOnRemindersSheetContent({ open, onOpenChange, onChanged }: TurnOnRemindersSheetProps) {
  const t = useTranslations('reminders_setup')
  const tCommon = useTranslations('common')
  const locale = errorLocale(useLocale())
  const { formatDateLong } = useFormat()
  const { appName } = useBranding()
  const { toast } = useToast()
  const { role } = useCompany()
  const { canWrite } = useCanWrite()
  // company_settings is written by owners and administrators only (PUT /api/settings answers 403 otherwise).
  const canManage = role === 'owner' || role === 'admin'

  const [overview, setOverview] = useState<ReminderOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // null: the saved days, as the overview has them.
  const [typedDays, setTypedDays] = useState<ReminderDaysInput | null>(null)
  const [level, setLevel] = useState<ReminderLevel>(1)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState<Busy>(null)
  const [results, setResults] = useState<PickedSendResult[] | null>(null)
  // The sent invoices leave the pick list on the next read; their rows keep the names they had.
  const [sentNames, setSentNames] = useState<Readonly<Record<string, string>>>({})
  const [sendError, setSendError] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const daysErrorId = useId()
  const preview = useReminderPreview(undefined, level, open && overview !== null && !overview.collectionsConnected)

  const load = useCallback(async (): Promise<ReminderOverview | null> => {
    const result = await fetchReminderOverview(locale)
    if (!result.ok) {
      setLoadError(result.message)
      return null
    }
    setOverview(result.data)
    setLoadError(null)
    return result.data
  }, [locale])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const handleOpenChange = (next: boolean) => {
    // A save or a send runs to its answer before the sheet closes.
    if (busy) return
    onOpenChange(next)
    if (!next) {
      setPicked(new Set())
      setResults(null)
      setSendError(null)
      setTypedDays(null)
    }
  }

  const savedDays = overview?.schedule.days
  const dayInputs = typedDays ?? (savedDays ? reminderDaysInput(savedDays) : null)
  const daysCheck = dayInputs ? checkReminderDays(dayInputs) : null
  const daysDirty = !!dayInputs && !!savedDays && reminderDaysChanged(dayInputs, savedDays)
  const mode: 'loading' | 'collections' | 'on' | 'off' = !overview
    ? 'loading'
    : overview.enabled
      ? 'on'
      : overview.collectionsConnected
        ? 'collections'
        : 'off'
  const pickable = overview && !overview.collectionsConnected ? overview.pickable : []

  const nameOf = (invoice: PickableInvoice) =>
    [invoice.customer_name ?? t('pick_no_customer'), invoice.invoice_number ?? t('pick_no_number')].join(' · ')

  const setDay = (index: number, value: string) => {
    const next: [string, string, string] = [...(dayInputs ?? ['', '', ''])] as [string, string, string]
    next[index] = value
    setTypedDays(next)
  }

  const togglePick = (invoiceId: string) =>
    setPicked((previous) => {
      const next = new Set(previous)
      if (next.has(invoiceId)) next.delete(invoiceId)
      else next.add(invoiceId)
      return next
    })

  async function send(invoiceIds: string[], bankAttested: boolean) {
    const names = Object.fromEntries(pickable.filter((p) => invoiceIds.includes(p.invoice_id)).map((p) => [p.invoice_id, nameOf(p)]))
    setSentNames((previous) => ({ ...previous, ...names }))
    const outcome = await sendPickedReminders(locale, invoiceIds, bankAttested)
    setResults((previous) => (bankAttested && previous ? mergeSendResults(previous, outcome.results) : outcome.results))
    setSendError(outcome.error)
    setPicked(new Set())
    await load()
  }

  async function turnOn() {
    if (!daysCheck?.ok) return
    setBusy('turn_on')
    setSendError(null)
    try {
      const saved = await saveReminderSettings(locale, { on: true, days: daysCheck.days })
      if (!saved.ok) {
        toast({ title: t('save_failed'), description: saved.message, variant: 'destructive' })
        return
      }
      setTypedDays(null)
      toast({ title: t('toast_on') })
      const next = await load()
      if (next) onChanged?.(next)
      if (picked.size > 0) await send([...picked], false)
    } finally {
      setBusy(null)
    }
  }

  async function sendNow(invoiceIds: string[], bankAttested: boolean) {
    setBusy('send')
    setSendError(null)
    try {
      await send(invoiceIds, bankAttested)
    } finally {
      setBusy(null)
    }
  }

  async function saveDays() {
    if (!daysCheck?.ok) return
    setBusy('days')
    try {
      const saved = await saveReminderSettings(locale, { days: daysCheck.days })
      if (!saved.ok) {
        toast({ title: t('save_failed'), description: saved.message, variant: 'destructive' })
        return
      }
      setTypedDays(null)
      toast({ title: t('toast_days_saved') })
      const next = await load()
      if (next) onChanged?.(next)
    } finally {
      setBusy(null)
    }
  }

  async function turnOff() {
    setBusy('turn_off')
    try {
      const saved = await saveReminderSettings(locale, { on: false })
      if (!saved.ok) {
        toast({ title: t('save_failed'), description: saved.message, variant: 'destructive' })
        return
      }
      toast({ title: t('toast_off') })
      const next = await load()
      if (next) onChanged?.(next)
    } finally {
      setBusy(null)
    }
  }

  const title = mode === 'on' ? t('title_on') : mode === 'off' ? t('title_off') : t('kicker')

  return (
    <>
      <SlideOver open={open} onOpenChange={handleOpenChange}>
        <SlideOverContent aria-describedby={undefined}>
          <SlideOverHeader
            kicker={mode === 'on' || mode === 'off' ? t('kicker') : undefined}
            title={title}
            closeLabel={t('close')}
          />
          <SlideOverBody className="space-y-6">
            {mode === 'loading' &&
              (loadError ? (
                <div className="flex items-center justify-between gap-3 text-[13px] text-muted-foreground">
                  <span>{loadError}</span>
                  <Button variant="outline" size="sm" onClick={() => void load()}>
                    {t('retry')}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ))}

            {/* A reload that failed after a change: the sheet still shows the state before it. */}
            {mode !== 'loading' && loadError && (
              <div className="flex items-center justify-between gap-3 text-[13px] text-destructive">
                <span>{loadError}</span>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  {t('retry')}
                </Button>
              </div>
            )}

            {results && (
              <ReminderSendResults
                results={results}
                describe={(invoiceId) => sentNames[invoiceId] ?? t('pick_no_number')}
                canWrite={canWrite}
                onAttestedRetry={(ids) => sendNow(ids, true)}
              />
            )}
            {sendError && <p className="text-[13px] text-destructive">{sendError}</p>}

            {overview?.collectionsConnected && <p className="text-[13px] leading-relaxed">{t('collections_note', { appName })}</p>}

            {(mode === 'on' || mode === 'off') && overview && dayInputs && (
              <>
                <p className="text-[13px] leading-relaxed">
                  {mode === 'off'
                    ? t('intro', { appName })
                    : overview.enabledAt
                      ? t('status_on', { date: formatDateLong(overview.enabledAt) })
                      : t('status_on_undated')}
                </p>

                <section className="space-y-2">
                  <h2 className={SECTION_HEADING_CLASS}>{t('days_heading')}</h2>
                  <div className="grid grid-cols-3 gap-3">
                    {REMINDER_LEVELS.map((dayLevel) => (
                      <label key={dayLevel} className="block space-y-1 text-[12.5px] text-muted-foreground">
                        <span className="block truncate">{t(`level_name_${dayLevel}`)}</span>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={365}
                          value={dayInputs[dayLevel - 1]}
                          onChange={(event) => setDay(dayLevel - 1, event.target.value)}
                          disabled={!canManage || busy !== null}
                          aria-invalid={daysCheck?.ok === false && daysCheck.level === dayLevel}
                          aria-describedby={daysCheck?.ok === false && daysCheck.level === dayLevel ? daysErrorId : undefined}
                          className="tabular-nums"
                        />
                      </label>
                    ))}
                  </div>
                  {daysCheck && !daysCheck.ok && (
                    <p id={daysErrorId} className="text-[12.5px] text-destructive">
                      {t(`days_error_${daysCheck.error}`, { level: t(`level_name_${daysCheck.level}`) })}
                    </p>
                  )}
                </section>

                {mode === 'on' && (
                  <section className="space-y-2">
                    <h2 className={SECTION_HEADING_CLASS}>{t('automatic_heading')}</h2>
                    <AutomaticRemindersControl
                      state={overview.automatic}
                      onChanged={(automatic) => setOverview((current) => (current ? { ...current, automatic } : current))}
                    />
                  </section>
                )}

                {!overview.collectionsConnected && (
                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className={SECTION_HEADING_CLASS}>{t('preview_heading')}</h2>
                      <SegmentedControl<'1' | '2' | '3'>
                        aria-label={t('preview_levels_aria')}
                        value={String(level) as '1' | '2' | '3'}
                        onChange={(next) => setLevel(Number(next) as ReminderLevel)}
                        options={REMINDER_LEVELS.map((option) => ({
                          value: String(option) as '1' | '2' | '3',
                          label: t(`level_short_${option}`),
                        }))}
                      />
                    </div>
                    <ReminderMailPreview result={preview.result} onRetry={preview.retry} />
                    <p className="text-[12.5px] text-muted-foreground">{t('preview_no_fee')}</p>
                  </section>
                )}

                {mode === 'off' && <p className="text-[13px] leading-relaxed">{t('consequence', { appName })}</p>}

                {pickable.length > 0 && (
                  <section className="space-y-2">
                    <p className="text-[13px]">{t('pick_question', { count: pickable.length })}</p>
                    <p className="text-[12.5px] text-muted-foreground">
                      {mode === 'off' && !canManage ? t('pick_hint_send_only') : t('pick_hint')}
                      {overview.pickableTruncated && <> {t('pick_truncated')}</>}
                    </p>
                    <PickList invoices={pickable} picked={picked} onToggle={togglePick} disabled={!canWrite || busy !== null} />
                  </section>
                )}

                {!canManage && <p className="text-[12.5px] text-muted-foreground">{t('admin_only')}</p>}
              </>
            )}
          </SlideOverBody>
          <SlideOverFooter className="flex-wrap">
            {mode === 'on' && canManage && (
              <Button variant="ghost" className="mr-auto" disabled={busy !== null} onClick={() => setConfirmOff(true)}>
                {t('turn_off')}
              </Button>
            )}
            {mode === 'off' ? (
              <>
                <Button variant="ghost" disabled={busy !== null} onClick={() => handleOpenChange(false)}>
                  {tCommon('cancel')}
                </Button>
                {canManage ? (
                  <Button
                    disabled={!daysCheck?.ok || (busy !== null && busy !== 'turn_on')}
                    loading={busy === 'turn_on'}
                    onClick={() => void turnOn()}
                  >
                    {picked.size > 0 ? t('turn_on_and_send', { count: picked.size }) : t('turn_on')}
                  </Button>
                ) : (
                  // A member cannot turn reminders on, but may send the picked
                  // ones now: the send route takes a pick with reminders off.
                  picked.size > 0 && (
                    <Button
                      disabled={!canWrite || (busy !== null && busy !== 'send')}
                      loading={busy === 'send'}
                      onClick={() => void sendNow([...picked], false)}
                    >
                      {t('send_now', { count: picked.size })}
                    </Button>
                  )
                )}
              </>
            ) : mode === 'on' ? (
              <>
                {daysDirty && (
                  <Button
                    variant={picked.size > 0 ? 'outline' : 'default'}
                    disabled={!canManage || !daysCheck?.ok || (busy !== null && busy !== 'days')}
                    loading={busy === 'days'}
                    onClick={() => void saveDays()}
                  >
                    {t('save_days')}
                  </Button>
                )}
                {picked.size > 0 && (
                  <Button
                    disabled={!canWrite || (busy !== null && busy !== 'send')}
                    loading={busy === 'send'}
                    onClick={() => void sendNow([...picked], false)}
                  >
                    {t('send_now', { count: picked.size })}
                  </Button>
                )}
                {!daysDirty && picked.size === 0 && (
                  <Button variant="outline" disabled={busy !== null} onClick={() => handleOpenChange(false)}>
                    {t('close')}
                  </Button>
                )}
              </>
            ) : (
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t('close')}
              </Button>
            )}
          </SlideOverFooter>
        </SlideOverContent>
      </SlideOver>
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title={t('turn_off_confirm_title')}
        description={t('turn_off_confirm_body')}
        confirmLabel={t('turn_off_confirm')}
        onConfirm={turnOff}
      />
    </>
  )
}

/** The overdue invoices offered once: each unticked, one hairline row with who gets the mail. */
function PickList({
  invoices,
  picked,
  onToggle,
  disabled,
}: {
  invoices: readonly PickableInvoice[]
  picked: ReadonlySet<string>
  onToggle: (invoiceId: string) => void
  disabled: boolean
}) {
  const t = useTranslations('reminders_setup')
  return (
    <ul className="divide-y divide-border border-y border-border">
      {invoices.map((invoice) => (
        <li key={invoice.invoice_id}>
          <label className="flex cursor-pointer items-start gap-3 px-2 py-2 text-[13px] transition-colors hover:bg-secondary/35">
            <Checkbox
              checked={picked.has(invoice.invoice_id)}
              onCheckedChange={() => onToggle(invoice.invoice_id)}
              disabled={disabled}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate" data-ph-mask="">
                  {invoice.customer_name ?? t('pick_no_customer')}
                </span>
                <span className="shrink-0 tabular-nums">{formatCurrency(invoice.remaining_amount, invoice.currency)}</span>
              </span>
              <span className="block truncate text-[12.5px] text-muted-foreground">
                <span className="tabular-nums">{invoice.invoice_number ?? t('pick_no_number')}</span>
                {' · '}
                <span className="tabular-nums">{t('pick_days', { count: invoice.overdue_days })}</span>
                {' · '}
                <span data-ph-mask="">{invoice.recipient}</span>
              </span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}
