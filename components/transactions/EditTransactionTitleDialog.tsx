'use client'

import { useEffect, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'

interface EditTransactionTitleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Current (possibly edited) title shown in the input. */
  currentTitle: string
  /** Bank's original title; when it differs from the current title a restore
   *  affordance is offered. */
  originalTitle: string | null
  /** Persist a new title. Resolves true on success (dialog closes), false to
   *  keep the dialog open (e.g. the request failed). */
  onSave: (description: string) => Promise<boolean>
}

/**
 * Edit a bank transaction's working title. Carries the product-required warning
 * ("Är du säker…") in the dialog body and offers a one-click restore back to
 * the bank's original name. Gating (only unbooked/unmatched rows) is enforced
 * server-side; callers only open this for editable rows.
 */
export default function EditTransactionTitleDialog({
  open,
  onOpenChange,
  currentTitle,
  originalTitle,
  onSave,
}: EditTransactionTitleDialogProps) {
  const t = useTranslations('tx_inbox_card')
  const [value, setValue] = useState(currentTitle)
  const [isSaving, setIsSaving] = useState(false)

  // Re-seed the field each time the dialog opens for a (possibly different) row.
  useEffect(() => {
    if (open) setValue(currentTitle)
  }, [open, currentTitle])

  const trimmed = value.trim()
  const canRestore = originalTitle != null && originalTitle !== currentTitle
  const isUnchanged = trimmed === currentTitle.trim()

  async function persist(next: string) {
    setIsSaving(true)
    try {
      const ok = await onSave(next)
      if (ok) onOpenChange(false)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isSaving) return
        onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('edit_title_dialog_title')}</DialogTitle>
          <DialogDescription>{t('edit_title_warning')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="tx-title-input">{t('edit_title_label')}</Label>
          <Input
            id="tx-title-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={500}
            autoFocus
            disabled={isSaving}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed && !isUnchanged && !isSaving) {
                e.preventDefault()
                void persist(trimmed)
              }
            }}
          />
          {canRestore && (
            <p className="text-xs text-muted-foreground">
              {t('edit_title_original_hint', { name: originalTitle as string })}{' '}
              <button
                type="button"
                onClick={() => void persist(originalTitle as string)}
                disabled={isSaving}
                className="underline underline-offset-2 hover:text-foreground transition-colors disabled:opacity-50"
              >
                {t('edit_title_restore')}
              </button>
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
            className="min-h-11 w-full sm:w-auto"
          >
            {t('edit_title_cancel')}
          </Button>
          <Button
            onClick={() => void persist(trimmed)}
            disabled={isSaving || !trimmed || isUnchanged}
            className="min-h-11 w-full sm:w-auto"
          >
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t('edit_title_save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
