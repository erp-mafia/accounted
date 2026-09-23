'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ClipboardCheck } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatDate } from '@/lib/utils'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { BokslutChecklist as Checklist, ChecklistGroup, ChecklistItem, ChecklistState } from '@/lib/bokslut/checklist'

/**
 * The bokslut checklist on the wizard's Kontroll step: every closing step
 * grouped as the work goes, the system-judged ones read-only with their
 * computed state, the manual ones ticked here and stored per period
 * (bokslut_checklist_items). Any step can be marked not applicable.
 */

const GROUP_ORDER: ChecklistGroup[] = ['avstamning', 'periodisering', 'vardering', 'dispositioner', 'kontroll', 'rapportering']

interface BokslutChecklistProps {
  periodId: string
}

export function BokslutChecklist({ periodId }: BokslutChecklistProps) {
  const t = useTranslations('bokslut_checklist')
  const locale = useLocale()
  const { toast } = useToast()
  const [checklist, setChecklist] = useState<Checklist | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const base = `/api/bookkeeping/fiscal-periods/${periodId}/bokslut-checklist`

  const load = useCallback(async () => {
    try {
      const res = await fetch(base)
      if (!res.ok) {
        setFailed(true)
        return
      }
      const json = await res.json()
      setChecklist(json.data as Checklist)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [base])

  useEffect(() => {
    void load()
  }, [load])

  async function set(item: ChecklistItem, state: ChecklistState) {
    setBusy(item.key)
    try {
      const res = await fetch(base, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_key: item.key, state }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: t('save_failed'), description: getUserErrorMessage(json, { statusCode: res.status }), variant: 'destructive' })
        return
      }
      setChecklist(json.data as Checklist)
    } finally {
      setBusy(null)
    }
  }

  if (failed) return null
  if (!checklist) {
    return (
      <section aria-busy className="space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </section>
    )
  }

  const label = (item: ChecklistItem) => (locale === 'en' ? item.label_en : item.label_sv)

  return (
    <section>
      <div className="mb-1 flex items-center gap-2 px-1">
        <ClipboardCheck className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('heading')}</h3>
        <span className="text-[11px] tabular-nums text-muted-foreground" data-ph-mask>
          {t('progress', { done: checklist.summary.done + checklist.summary.not_applicable, total: checklist.summary.total })}
        </span>
        <div className="h-px flex-1 bg-border/60" />
      </div>
      {GROUP_ORDER.map((group) => {
        const items = checklist.items.filter((i) => i.group === group)
        if (items.length === 0) return null
        return (
          <div key={group} className="px-1 pt-2">
            <p className="text-[11px] font-medium text-muted-foreground">{t(`group_${group}`)}</p>
            <ul>
              {items.map((item) => {
                const done = item.effective_state === 'done'
                const na = item.effective_state === 'not_applicable'
                // Auto items are judged by the system; the stored override
                // (typically "ej tillämpligt") is the only thing to toggle.
                const toggleable = !item.auto || item.stored_state != null
                return (
                  <li
                    key={item.key}
                    className="group flex items-start gap-3 border-b border-border/60 py-2.5 text-[13px] leading-5 last:border-b-0"
                  >
                    <Checkbox
                      checked={done}
                      disabled={busy !== null || na || (item.auto && item.stored_state == null)}
                      onCheckedChange={(v) => void set(item, v === true ? 'done' : 'open')}
                      aria-label={label(item)}
                      className="mt-0.5"
                    />
                    <span className={cn('min-w-0 flex-1', na && 'text-muted-foreground line-through')}>
                      {label(item)}
                      {item.auto && item.stored_state == null && (
                        <span className="ml-1.5 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground no-underline">
                          {t('auto_chip')}
                        </span>
                      )}
                      {item.done_at && !item.auto && (
                        <span className="ml-1.5 text-[11.5px] text-muted-foreground">{t('done_at', { date: formatDate(item.done_at) })}</span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      {item.href && !done && !na && (
                        <Link href={item.href} className={QUIET_LINK_CLASS}>
                          {t('open')}
                        </Link>
                      )}
                      {na ? (
                        <button type="button" onClick={() => void set(item, 'open')} disabled={busy !== null} className={QUIET_LINK_CLASS}>
                          {t('reopen')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void set(item, 'not_applicable')}
                          disabled={busy !== null}
                          className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
                        >
                          {t('not_applicable')}
                        </button>
                      )}
                      {toggleable && item.auto && item.stored_state != null && !na && (
                        <button type="button" onClick={() => void set(item, 'open')} disabled={busy !== null} className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}>
                          {t('use_auto')}
                        </button>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
