'use client'

import { useState, useCallback, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DestructiveConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'destructive' | 'warning'
  onConfirm: () => void | Promise<void>
}

export function DestructiveConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Bekräfta',
  cancelLabel = 'Avbryt',
  variant = 'destructive',
  onConfirm,
}: DestructiveConfirmDialogProps) {
  const [isLoading, setIsLoading] = useState(false)

  const handleConfirm = async () => {
    setIsLoading(true)
    try {
      await onConfirm()
    } finally {
      setIsLoading(false)
      onOpenChange(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isLoading) return
        onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full',
                variant === 'destructive'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-warning/10 text-warning'
              )}
            >
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
            className="min-h-11 w-full sm:w-auto"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={isLoading}
            className={cn(
              'min-h-11 w-full sm:w-auto',
              variant === 'warning' && 'bg-warning hover:bg-warning/90 text-warning-foreground'
            )}
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ConfirmOptions {
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'destructive' | 'warning'
}

interface UseDestructiveConfirmReturn {
  dialogProps: DestructiveConfirmDialogProps
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

/**
 * Hook that returns a `confirm()` function as a drop-in replacement for `window.confirm()`.
 * Returns `Promise<boolean>`: true if user confirms, false if they cancel.
 *
 * Usage:
 * ```
 * const { dialogProps, confirm } = useDestructiveConfirm()
 *
 * async function handleDelete() {
 *   const ok = await confirm({ title: '...', description: '...' })
 *   if (!ok) return
 *   // proceed with deletion
 * }
 *
 * return <><DestructiveConfirmDialog {...dialogProps} /></>
 * ```
 */
export function useDestructiveConfirm(): UseDestructiveConfirmReturn {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ConfirmOptions>({
    title: '',
    description: '',
  })
  const resolveRef = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    setOptions(opts)
    setOpen(true)
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
    })
  }, [])

  const handleOpenChange = useCallback((v: boolean) => {
    setOpen(v)
    if (!v && resolveRef.current) {
      resolveRef.current(false)
      resolveRef.current = null
    }
  }, [])

  const handleConfirm = useCallback(() => {
    if (resolveRef.current) {
      resolveRef.current(true)
      resolveRef.current = null
    }
  }, [])

  return {
    dialogProps: {
      open,
      onOpenChange: handleOpenChange,
      title: options.title,
      description: options.description,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      variant: options.variant,
      onConfirm: handleConfirm,
    },
    confirm,
  }
}
