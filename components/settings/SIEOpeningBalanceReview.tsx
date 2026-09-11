'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { FiscalPeriod } from '@/types'

/** A review acknowledgment changes metadata only; corrections use the entry UI. */
export function SIEOpeningBalanceReview({ period, canManage }: { period: FiscalPeriod; canManage: boolean }) {
  const t = useTranslations('settings_bookkeeping')
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!period.opening_balance_review_token) return null

  async function acknowledge() {
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(`/api/bookkeeping/fiscal-periods/${period.id}/opening-balance-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewToken: period.opening_balance_review_token, expectedEntryId: period.opening_balance_entry_id }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || t('ib_review_failed'))
      await invalidateReferenceData('ref:fiscal-periods')
      toast({ title: t('ib_review_saved') })
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err) : t('ib_review_failed'))
    } finally { setSaving(false) }
  }

  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t('ib_review_action')}</Button>
    <Dialog open={open} onOpenChange={value => { if (!saving) setOpen(value) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ib_review_title', { name: period.name })}</DialogTitle>
          <DialogDescription>{t('ib_review_description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-3">
          {period.opening_balance_entry_id && <Button asChild variant="outline">
            <Link href={`/bookkeeping/${period.opening_balance_entry_id}`} target="_blank" rel="noopener noreferrer">{t('ib_review_entry')}</Link>
          </Button>}
          <Button asChild variant="outline">
            <Link href={`/import?mode=sie&job=${period.opening_balance_review_import_id}`} target="_blank" rel="noopener noreferrer">{t('ib_review_import')}</Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t('ib_review_confirm_help')}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>{t('fy_confirm_cancel')}</Button>
          {canManage && <Button disabled={saving} onClick={acknowledge}>{saving ? t('ib_review_saving') : t('ib_review_confirm')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
