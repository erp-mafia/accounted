'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { useAttribution } from '@/lib/attribution/use-attribution'
import { readableName } from '@/lib/inkorg/names'
import type { RemovedInboxItem } from '@/lib/operations/inbox-restore'
import { cn, formatCurrency, formatDateLong } from '@/lib/utils'
import { fetchRemovedItems, restoreRemovedItem } from './removed-items-client'

/**
 * Senast borttagna: the quiet way back for a document taken out of the
 * inbox by mistake. A link that opens the last deleted items (GET
 * /api/inkorg/items/removed: what can still be put back, newest first), each
 * with "Lägg tillbaka" (POST /api/inkorg/items/restore), which brings the
 * item back as it was deleted. Shared by the Inkorg and the Underlag
 * workspace; offered only to someone who may remove, since the same right
 * puts back.
 */
export function RemovedItemsLink({
  onRestored,
  className,
}: {
  /** An item is back in the inbox: the page reads its list again. */
  onRestored: () => void | Promise<void>
  className?: string
}) {
  const t = useTranslations('inkorg')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn(QUIET_LINK_CLASS, className)}>
        {t('removed_open')}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('removed_open')}</DialogTitle>
            <DialogDescription>{t('removed_lead')}</DialogDescription>
          </DialogHeader>
          {/* Mounted with the dialog, so every opening reads the list as it is now. */}
          <RemovedItemsList onRestored={onRestored} />
          <DialogFooter>
            <Button onClick={() => setOpen(false)}>{t('done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function RemovedItemsList({ onRestored }: { onRestored: () => void | Promise<void> }) {
  const t = useTranslations('inkorg')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const { format: attribute } = useAttribution()
  // Keyed by the attempt, so "Försök igen" reads as loading without a reset in the effect.
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<{ attempt: number; items: RemovedInboxItem[] | null } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Why an item could not be put back, said on its row for as long as the dialog is open.
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(() => new Map())
  const loaded = answer && answer.attempt === attempt ? answer : null

  useEffect(() => {
    let cancelled = false
    fetchRemovedItems().then(
      (items) => {
        if (!cancelled) setAnswer({ attempt, items })
      },
      () => {
        if (!cancelled) setAnswer({ attempt, items: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  async function putBack(item: RemovedInboxItem) {
    const id = item.inbox_item_id
    setBusyId(id)
    try {
      const result = await restoreRemovedItem(id, locale)
      if (!result.ok) {
        setRefusals((current) => new Map(current).set(id, result.message || t('removed_restore_failed')))
        return
      }
      setAnswer((current) => (current?.items ? { ...current, items: current.items.filter((other) => other.inbox_item_id !== id) } : current))
      toast({ title: t('removed_restored', { count: 1 }) })
      await onRestored()
    } finally {
      setBusyId(null)
    }
  }

  if (!loaded) {
    return (
      <LateReveal className="divide-y divide-border border-y border-border">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </LateReveal>
    )
  }
  if (!loaded.items) {
    return <LoadError className="pt-2" title={t('removed_load_failed')} onRetry={() => setAttempt((n) => n + 1)} />
  }
  if (loaded.items.length === 0) {
    return <p className="text-[13px] text-muted-foreground">{t('removed_empty')}</p>
  }

  return (
    <ul className="divide-y divide-border border-y border-border">
      {loaded.items.map((item) => {
        const vendor = item.vendor_name ? readableName(item.vendor_name) : null
        const name = vendor ?? item.file_name ?? item.email_subject ?? t('removed_untitled')
        const date = formatDateLong(item.removed_at, locale)
        // Who is named only when the deletion recorded one: a person, or the agent that acted for them.
        const who =
          item.removed_by.user_id || item.removed_by.actor_type !== 'user'
            ? attribute({ actorType: item.removed_by.actor_type, userId: item.removed_by.user_id }, { inline: true })
            : null
        const when = who ? t('removed_when_by', { date, who }) : t('removed_when', { date })
        const refusal = refusals.get(item.inbox_item_id)
        return (
          <li key={item.inbox_item_id} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-3">
                <span data-ph-mask="" className="min-w-0 flex-1 truncate text-[13px] font-medium text-strong">
                  {name}
                </span>
                {item.amount != null && (
                  <span data-ph-mask="" className="shrink-0 text-[13px] tabular-nums">
                    {formatCurrency(item.amount, item.currency)}
                  </span>
                )}
              </div>
              <p data-ph-mask="" className="truncate text-xs text-muted-foreground">
                {[vendor ? item.file_name : null, when].filter(Boolean).join(' · ')}
              </p>
              {refusal && (
                <p role="alert" className="mt-0.5 text-xs text-destructive">
                  {refusal}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              className="shrink-0"
              loading={busyId === item.inbox_item_id}
              disabled={busyId !== null && busyId !== item.inbox_item_id}
              onClick={() => void putBack(item)}
              aria-label={t('removed_restore_aria', { name })}
            >
              {t('removed_restore')}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
