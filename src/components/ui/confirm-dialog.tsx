'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /**
   * Body text that DESCRIBES THE OUTCOME up front ("Bokförs som verifikat
   * A-217 med 1 250,00 kr ...") instead of the page commenting afterwards
   * (UI-migration convention 10).
   */
  description?: React.ReactNode
  /** Optional richer body (e.g. a kontering preview) rendered below the description. */
  children?: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** Await-able: the dialog shows a pending state until the promise settles. */
  onConfirm: () => void | Promise<void>
  /** Terracotta confirm for destructive outcomes (avvisa, makulera). */
  destructive?: boolean
  /**
   * A second way on, beside the confirm (e.g. "Vänd bara verifikationen"
   * when the confirm leads with the owner's own action). It closes the
   * dialog and hands over; it never runs while the confirm is pending.
   */
  secondaryLabel?: string
  onSecondary?: () => void
  /** Holds the confirm back while the body is not ready to act on (a preview loading or refused). */
  confirmDisabled?: boolean
}

/**
 * Small centered confirmation dialog (min 460px on desktop): confirm before
 * acting, describing the outcome, rather than commenting after the fact.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = false,
  secondaryLabel,
  onSecondary,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  const tCommon = useTranslations('common')
  const [pending, setPending] = useState(false)

  const handleConfirm = async () => {
    try {
      setPending(true)
      await onConfirm()
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent size="confirm">
        <DialogHeader>
          {/* data-ph-mask: confirm dialogs describe the object being acted
              on (convention 10), so title and description are user data in
              session replays, not chrome. Mask wins over the primitives'
              own data-ph-unmask. */}
          <DialogTitle data-ph-mask="">
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription data-ph-mask="" className="text-[13px] leading-5">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {cancelLabel ?? tCommon('cancel')}
          </Button>
          {secondaryLabel && onSecondary && (
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false)
                onSecondary()
              }}
              disabled={pending}
            >
              {secondaryLabel}
            </Button>
          )}
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => void handleConfirm()}
            disabled={confirmDisabled}
            loading={pending}
            className={cn(pending && 'cursor-wait')}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
