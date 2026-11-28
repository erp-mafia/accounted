'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogConsequence,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isOverduePayable } from '@/lib/supplier-invoices/lifecycle'
import { cn } from '@/lib/utils'

/**
 * The due date of a supplier invoice not yet paid, moved after it was
 * registered. PUT /api/supplier-invoices/[id] takes it on any unsettled
 * invoice (lib/supplier-invoices/update-header.ts, the rule the API and the
 * MCP tool share) and moves the overdue label with it in the same write. The
 * due date is not on the verifikat, so nothing is booked. A refusal is the
 * server's sentence in the footer. Mounted per opening, so the field starts
 * from the stored date each time.
 */
export function DueDateDialog({
  invoice,
  onOpenChange,
  onSaved,
}: {
  invoice: { id: string; due_date: string; remaining_amount: number; is_credit_note: boolean | null }
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const t = useTranslations('supplier_invoice_detail')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const [value, setValue] = useState(invoice.due_date)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const changed = value !== '' && value !== invoice.due_date

  // What the overdue label does with the new date: the predicate the server
  // writes the label from and the daily check flips on, asked of the stored
  // date and of the new one.
  const today = todayIsoStockholm()
  const facts = { remaining_amount: invoice.remaining_amount, is_credit_note: invoice.is_credit_note }
  const overdueNow = isOverduePayable({ ...facts, due_date: invoice.due_date }, today)
  const overdueAfter = changed && isOverduePayable({ ...facts, due_date: value }, today)
  const consequence = !changed
    ? null
    : overdueNow && !overdueAfter
      ? t('due_date_no_longer_overdue')
      : !overdueNow && overdueAfter
        ? t('due_date_becomes_overdue')
        : null

  async function save() {
    if (!changed || saving) return
    setSaving(true)
    setFailure(null)
    try {
      const res = await fetch(`/api/supplier-invoices/${invoice.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_date: value }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setFailure(getErrorMessage(body, { statusCode: res.status, context: 'supplier_invoice', locale }))
        return
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setFailure(getErrorMessage(err, { context: 'supplier_invoice', locale }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (saving ? undefined : onOpenChange(open))}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>{t('due_date_dialog_title')}</DialogTitle>
          <DialogDescription>{t('due_date_dialog_description')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Label htmlFor="supplier-invoice-due-date">{t('due_date_label')}</Label>
          <Input
            id="supplier-invoice-due-date"
            type="date"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setFailure(null)
            }}
            autoFocus
            className="w-fit"
          />
        </form>
        <DialogFooter>
          <DialogConsequence
            role={failure ? 'alert' : undefined}
            aria-live={failure ? undefined : 'polite'}
            className={cn(failure && 'text-destructive')}
          >
            {failure ?? consequence}
          </DialogConsequence>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!changed}>
            {tCommon('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
