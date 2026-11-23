'use client'

import { ReactNode, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'

interface ConfirmationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isSubmitting: boolean
  title: string
  /** Help behind a "?" beside the title (convention 7): the why and the
   *  how, so the body can state one fact. */
  help?: ReactNode
  /** The one attention sentence above the buttons; a node when it carries a link. */
  warningText?: ReactNode
  confirmLabel?: string
  extraActions?: ReactNode
  children: ReactNode
  // When true, initial focus lands on the confirm button so Enter fires the
  // primary action. Opt-in: never arm Enter on unrelated/destructive dialogs.
  autoFocusConfirm?: boolean
  // Holds the confirm button until the caller's own gate opens (e.g. an
  // explicit acknowledgement checkbox rendered in children). Back stays
  // enabled: the dialog never traps the user.
  confirmDisabled?: boolean
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  onConfirm,
  isSubmitting,
  title,
  help,
  // No default warning: an accounting-immutability sentence used to be baked
  // in here, which put it into dialogs whose authors never asked for one.
  // Callers that commit a voucher directly pass their own warningText.
  warningText,
  confirmLabel = 'Bekräfta & skapa',
  extraActions,
  children,
  autoFocusConfirm,
  confirmDisabled = false,
}: ConfirmationDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="wide"
        className="flex flex-col gap-0 p-0"
        onOpenAutoFocus={autoFocusConfirm ? (e) => {
          e.preventDefault()
          confirmRef.current?.focus()
        } : undefined}
      >
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5">
          <div className="flex items-center gap-3">
            <div>
              {/* data-ph-mask on the title: confirm dialogs describe the
                  object being acted on (convention 10), so the title is user
                  data in session replays. The description is a static
                  sentence and stays readable. */}
              <div className="flex items-center gap-2">
                <DialogTitle data-ph-mask="">{title}</DialogTitle>
                {help ? <HelpPopover className="shrink-0">{help}</HelpPopover> : null}
              </div>
              <DialogDescription>Granska uppgifterna innan du bekräftar</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {children}
        </div>

        <div className="shrink-0 space-y-3 border-t-hairline px-5 py-3">
          {/* Attention is one ochre sentence, not a banner (convention 6). */}
          {warningText && <AttnLine>{warningText}</AttnLine>}

          {/* A plain row, not DialogFooter: that one draws a hairline of its
              own, and this block already has the one above it. On a phone the
              buttons stack full width at 44px, as in every dialog footer. */}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end max-sm:[&>button]:h-11 max-sm:[&>button]:w-full">
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Tillbaka
            </Button>
            {extraActions}
            <Button
              ref={confirmRef}
              onClick={onConfirm}
              disabled={confirmDisabled}
              loading={isSubmitting}
            >
              {isSubmitting ? 'Skapar...' : confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
