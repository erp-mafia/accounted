'use client'

import { ReactNode, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { ClipboardCheck, Loader2 } from 'lucide-react'

interface ConfirmationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isSubmitting: boolean
  title: string
  warningText?: string
  confirmLabel?: string
  extraActions?: ReactNode
  children: ReactNode
  // When true, initial focus lands on the confirm button so Enter fires the
  // primary action. Opt-in: never arm Enter on unrelated/destructive dialogs.
  autoFocusConfirm?: boolean
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  onConfirm,
  isSubmitting,
  title,
  // No default warning: an accounting-immutability sentence used to be baked
  // in here, which put it into dialogs whose authors never asked for one.
  // Callers that commit a voucher directly pass their own warningText.
  warningText,
  confirmLabel = 'Bekräfta & skapa',
  extraActions,
  children,
  autoFocusConfirm,
}: ConfirmationDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl border-t-2 border-primary p-0 gap-0 max-h-[95dvh] sm:max-h-[90dvh] flex flex-col"
        onOpenAutoFocus={autoFocusConfirm ? (e) => {
          e.preventDefault()
          confirmRef.current?.focus()
        } : undefined}
      >
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-6 pb-3 sm:pb-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 shrink-0">
              <ClipboardCheck className="h-5 w-5 text-primary" />
            </div>
            <div>
              {/* data-ph-mask on the title: confirm dialogs describe the
                  object being acted on (convention 10), so the title is user
                  data in session replays. The description is a static
                  sentence and stays readable. */}
              <DialogTitle data-ph-mask="" className="text-lg sm:text-xl">{title}</DialogTitle>
              <DialogDescription>Granska uppgifterna innan du bekräftar</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 min-h-0 px-4 sm:px-6 pb-4">
          {children}
        </div>

        <div className="border-t px-4 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-4 shrink-0">
          {/* Attention is one ochre sentence, not a banner (convention 6). */}
          {warningText && <AttnLine>{warningText}</AttnLine>}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
              className="min-h-11 w-full sm:w-auto"
            >
              Tillbaka
            </Button>
            {extraActions}
            <Button ref={confirmRef} onClick={onConfirm} disabled={isSubmitting} className="min-h-11 w-full sm:w-auto">
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Skapar...
                </>
              ) : (
                confirmLabel
              )}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
