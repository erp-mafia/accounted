'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import CustomerCombobox from '@/components/customers/CustomerCombobox'
import { useCustomers } from '@/lib/reference-data/hooks'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { CustomerMergeResult } from '@/lib/customers/merge-customers'

export interface MergeSubject {
  id: string
  name: string
  customer_number?: string | null
}

/**
 * Merge a duplicate customer card into this one, or this one into it
 * (crm#1398). The survivor is visible and swappable, the dry run says what
 * moves before anything does, and undo lives on the toast afterwards.
 */
export function CustomerMergeDialog({
  open,
  onOpenChange,
  subject,
  onMerged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  subject: MergeSubject
  onMerged: (result: CustomerMergeResult) => void
}) {
  const t = useTranslations('customer_detail')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const { customers, isLoading } = useCustomers()
  const [otherId, setOtherId] = useState('')
  const [survivorId, setSurvivorId] = useState(subject.id)
  const [preview, setPreview] = useState<CustomerMergeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const others = useMemo(() => customers.filter((c) => c.id !== subject.id), [customers, subject.id])
  const other = others.find((c) => c.id === otherId) ?? null
  const mergedId = survivorId === subject.id ? otherId : subject.id

  async function post(dryRun: boolean): Promise<CustomerMergeResult | null> {
    const response = await fetch('/api/customers/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ survivor_customer_id: survivorId, merged_customer_ids: [mergedId], dry_run: dryRun }),
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) {
      setError(getErrorMessage(json, { context: 'customer', locale: errorLocale }))
      return null
    }
    return (json as { data: CustomerMergeResult }).data
  }

  // The dry run for the pair and direction chosen: what would move.
  useEffect(() => {
    setPreview(null)
    setError(null)
    if (!otherId) return
    let cancelled = false
    void post(true).then((result) => {
      if (!cancelled) setPreview(result)
    })
    return () => {
      cancelled = true
    }
    // post reads the ids this effect depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherId, survivorId])

  async function confirm() {
    setBusy(true)
    try {
      const result = await post(false)
      if (result) onMerged(result)
    } finally {
      setBusy(false)
    }
  }

  const label = (c: MergeSubject) => (c.customer_number ? `${c.name} (${c.customer_number})` : c.name)
  const cards: MergeSubject[] = other ? [subject, other] : [subject]
  const totals = preview?.totals

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('merge_dialog_title')}</DialogTitle>
          <DialogDescription>{t('merge_dialog_body')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="customer-merge-other">{t('merge_other_label')}</Label>
            <CustomerCombobox
              id="customer-merge-other"
              value={otherId}
              customers={others}
              onChange={(id) => {
                setOtherId(id)
                setSurvivorId(subject.id)
              }}
              placeholder={t('merge_other_placeholder')}
              loading={isLoading}
            />
          </div>
          {other ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {cards.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-4 py-3 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-medium">{label(c)}</span>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="radio"
                      name="customer-merge-survivor"
                      className="h-4 w-4 accent-foreground"
                      checked={survivorId === c.id}
                      onChange={() => setSurvivorId(c.id)}
                    />
                    {survivorId === c.id ? t('merge_kept') : t('merge_keep')}
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          {totals ? (
            <p className="text-[13px] text-muted-foreground">
              {t('merge_preview', {
                invoices: totals.invoices,
                orders: totals.sales_orders,
                schedules: totals.recurring_invoice_schedules,
                deadlines: totals.deadlines,
                survivor: preview.survivor.name,
              })}
            </p>
          ) : null}
          {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {tCommon('cancel')}
          </Button>
          <Button type="button" onClick={() => void confirm()} loading={busy} disabled={!preview || !!error}>
            {t('merge_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
