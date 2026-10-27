'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BellAlertIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useCompany } from '@/contexts/CompanyContext'
import { useBranding } from '@/lib/branding/brand-context'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import type { ReminderOverview } from '@/lib/reminders/overview'
import { TURN_ON_OFFER_NOTICE_ID, turnOnEntry } from '@/lib/reminders/turn-on'
import { createClient } from '@/lib/supabase/client'
import { errorLocale, fetchReminderOverview } from './reminders-client'

/** Whether this user dismissed the offer for this company (POST /api/notices/dismiss; RLS reads only their own rows). */
async function offerDismissed(companyId: string): Promise<boolean> {
  const { data, error } = await createClient()
    .from('notice_dismissals')
    .select('notice_id')
    .eq('company_id', companyId)
    .eq('notice_id', TURN_ON_OFFER_NOTICE_ID)
    .limit(1)
  // Unreadable counts as not dismissed: the offer is quiet and can be dismissed again.
  if (error) return false
  return (data ?? []).length > 0
}

interface ListRemindersState {
  companyId: string
  overview: ReminderOverview | null
  dismissed: boolean
}

/**
 * The invoice list's way to reminders (accounted#104, phase 3): the overview
 * read once, after the list has loaded, and only while
 * REMINDERS_SENDING_ENABLED is on, so the list does no extra work while the
 * feature is dark. It decides the offer (off, something overdue, not
 * dismissed by this user for this company) or the quiet status control (on),
 * and holds the sheet both open.
 */
export function useInvoiceListReminders(active: boolean) {
  const locale = errorLocale(useLocale())
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const [state, setState] = useState<ListRemindersState | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const current = companyId && state?.companyId === companyId ? state : null
  const read = REMINDERS_SENDING_ENABLED && active && companyId !== null && current === null

  useEffect(() => {
    if (!read || !companyId) return
    let cancelled = false
    void (async () => {
      const result = await fetchReminderOverview(locale)
      // Without an overview the list offers nothing and carries on as before.
      const overview = result.ok ? result.data : null
      const dismissed = turnOnEntry(overview) === 'offer' ? await offerDismissed(companyId) : false
      if (!cancelled) setState({ companyId, overview, dismissed })
    })()
    return () => {
      cancelled = true
    }
  }, [read, companyId, locale])

  const dismiss = useCallback(() => {
    setState((previous) => (previous ? { ...previous, dismissed: true } : previous))
    void fetch('/api/notices/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notice_id: TURN_ON_OFFER_NOTICE_ID }),
    }).catch(() => {
      // Optimistic on purpose: a lost write only shows the offer again on the next visit.
    })
  }, [])

  const onChanged = useCallback(
    (overview: ReminderOverview) =>
      setState((previous) => (companyId ? { companyId, overview, dismissed: previous?.dismissed ?? false } : previous)),
    [companyId],
  )

  const entry = current ? turnOnEntry(current.overview) : null
  return {
    entry,
    offerShown: entry === 'offer' && current?.dismissed === false,
    overdueCount: current?.overview?.overdueCount ?? 0,
    dismiss,
    openSheet: () => setSheetOpen(true),
    sheet: { open: sheetOpen, onOpenChange: setSheetOpen, onChanged },
  }
}

/** The offer above the list: inline and dismissable, never in front of the page. */
export function RemindersOfferRow({ count, onOpen, onDismiss }: { count: number; onOpen: () => void; onDismiss: () => void }) {
  const t = useTranslations('reminders_setup')
  const { appName } = useBranding()
  return (
    <section
      aria-label={t('kicker')}
      className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="min-w-0 text-[13px]">{t('offer', { count, appName })}</p>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={onOpen}>
          {t('offer_action')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t('offer_dismiss')}
        </Button>
      </div>
    </section>
  )
}

/** "Påminnelser på" in the top bar: opens the same sheet, where reminders are turned off. */
export function RemindersStatusButton({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations('reminders_setup')
  return (
    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={onOpen}>
      <BellAlertIcon className="mr-2 h-4 w-4" />
      {t('status_control')}
    </Button>
  )
}
