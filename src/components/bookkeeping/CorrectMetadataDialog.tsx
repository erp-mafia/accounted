'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import RattelseExplainer from '@/components/bookkeeping/RattelseExplainer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { JournalEntry } from '@/types'

interface Props {
  entry: JournalEntry
  open: boolean
  onOpenChange: (open: boolean) => void
  onCorrected: () => void
}

/**
 * Metadata rättelse (BFL 5 kap 9 §): correct the verifikationstext and/or
 * the date (within the same fiscal period) of a posted verifikat without an
 * ändringsverifikation. Who/when is recorded in the immutable rättelse log
 * and shown in the verifikat's history.
 */
export default function CorrectMetadataDialog({ entry, open, onOpenChange, onCorrected }: Props) {
  const { toast } = useToast()
  const t = useTranslations('journal_detail')
  const tc = useTranslations('common')
  const [description, setDescription] = useState('')
  const [entryDate, setEntryDate] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setDescription(entry.description || '')
      setEntryDate(entry.entry_date?.slice(0, 10) || '')
    }
  }, [open, entry.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const descriptionChanged = description.trim() !== (entry.description || '')
  const dateChanged = entryDate !== (entry.entry_date?.slice(0, 10) || '')
  const hasChange = (descriptionChanged && description.trim().length > 0) || (dateChanged && entryDate.length > 0)

  async function handleSubmit() {
    if (!hasChange) return
    setIsSubmitting(true)
    try {
      const payload: { description?: string; entry_date?: string } = {}
      if (descriptionChanged && description.trim().length > 0) payload.description = description.trim()
      if (dateChanged && entryDate.length > 0) payload.entry_date = entryDate

      const res = await fetch(`/api/bookkeeping/journal-entries/${entry.id}/correct-metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await res.json()
      if (!res.ok) {
        const error = new Error('Failed to correct metadata') as Error & { body?: unknown; status?: number }
        error.body = result
        error.status = res.status
        throw error
      }
      toast({
        title: t('metadata_dialog_toast_corrected'),
        description: t('metadata_dialog_toast_corrected_description'),
      })
      onOpenChange(false)
      onCorrected()
    } catch (err) {
      const anyErr = err as { body?: unknown; status?: number }
      toast({
        title: t('metadata_dialog_toast_failed'),
        description: getErrorMessage(anyErr.body ?? err, { context: 'journal_entry', statusCode: anyErr.status }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          {/* Convention 7: the how-it-works copy lives behind the "?", not in
              the dialog flow. */}
          <div className="flex items-center gap-2">
            <DialogTitle>{t('correct_metadata')}</DialogTitle>
            <RattelseExplainer>
              <p>{t('metadata_dialog_explainer_1')}</p>
              <p>{t('metadata_dialog_explainer_2')}</p>
              <p>{t('metadata_dialog_explainer_3')}</p>
            </RattelseExplainer>
          </div>
          <DialogDescription>
            {t('metadata_dialog_description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="rattelse-description">{t('correction_dialog_description_label')}</Label>
            <Input
              id="rattelse-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rattelse-date">{t('metadata_dialog_date_label')}</Label>
            <Input
              id="rattelse-date"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              disabled={['storno', 'opening_balance', 'year_end'].includes(entry.source_type)}
            />
            {['storno', 'opening_balance', 'year_end'].includes(entry.source_type) && (
              <p className="text-xs text-muted-foreground">
                {t('metadata_dialog_date_locked')}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!hasChange || isSubmitting}>
            {isSubmitting ? t('metadata_dialog_saving') : t('metadata_dialog_save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
