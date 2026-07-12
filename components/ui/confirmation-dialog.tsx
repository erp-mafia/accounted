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
import { ClipboardCheck, Loader2, AlertTriangle } from 'lucide-react'

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
  warningText = 'En verifikation skapas och kan inte ändras efteråt.',
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
              <DialogTitle className="text-lg sm:text-xl">{title}</DialogTitle>
              <DialogDescription>Granska uppgifterna innan du bekräftar</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 min-h-0 px-4 sm:px-6 pb-4">
          {children}
        </div>

        <div className="border-t px-4 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-4 shrink-0">
          {warningText && (
            <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 p-3">
              <AlertTriangle className="h-4 w-4 text-warning-foreground mt-0.5 shrink-0" />
              <p className="text-sm text-warning-foreground">{warningText}</p>
            </div>
          )}

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
