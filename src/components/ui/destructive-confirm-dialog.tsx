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
                  : 'bg-muted text-attn'
              )}
            >
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              {/* data-ph-mask: confirm dialogs describe the object being
                  acted on (convention 10), so title and description are user
                  data in session replays, not chrome. */}
              <DialogTitle data-ph-mask="">{title}</DialogTitle>
              {/* pre-line so callers can pass newline-separated paragraphs
                  (e.g. the salary unapprove confirm assembles its copy
                  dynamically); single-line descriptions render unchanged. */}
              <DialogDescription data-ph-mask="" className="whitespace-pre-line">
                {description}
              </DialogDescription>
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
          {/* Warning-variant confirms use the default primary button: in
              chrome only --destructive survives as a colored action. */}
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={isLoading}
            className="min-h-11 w-full sm:w-auto"
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
  confirm: (options: ConfirmOptions, action?: () => void | Promise<void>) => Promise<boolean>
}

/**
 * Hook that returns a `confirm()` function as a drop-in replacement for `window.confirm()`.
 * Returns `Promise<boolean>`: true if user confirms, false if they cancel.
 *
 * Pass the destructive operation itself as the second argument to run it
 * INSIDE the confirm: the dialog stays open with its pending spinner (and
 * blocks dismissal) until the action settles, instead of closing on click and
 * leaving the fetch to run with no visible state anywhere. The action owns its
 * own error feedback (toast); if it throws, `confirm` resolves `false` so a
 * caller's success tail is skipped.
 *
 * Usage:
 * ```
 * const { dialogProps, confirm } = useDestructiveConfirm()
 *
 * async function handleDelete() {
 *   const ok = await confirm({ title: '...', description: '...' }, async () => {
 *     // the DELETE runs while the dialog shows its spinner
 *   })
 *   if (!ok) return
 *   // confirmed and the action completed
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
  const actionRef = useRef<(() => void | Promise<void>) | null>(null)
  const runningRef = useRef(false)

  const confirm = useCallback(
    (opts: ConfirmOptions, action?: () => void | Promise<void>): Promise<boolean> => {
      setOptions(opts)
      actionRef.current = action ?? null
      setOpen(true)
      return new Promise<boolean>((resolve) => {
        resolveRef.current = resolve
      })
    },
    [],
  )

  const handleOpenChange = useCallback((v: boolean) => {
    setOpen(v)
    if (!v) {
      actionRef.current = null
      if (resolveRef.current) {
        resolveRef.current(false)
        resolveRef.current = null
      }
    }
  }, [])

  const handleConfirm = useCallback(async () => {
    // Re-entry guard: a second confirm firing while the action is still in
    // flight must not resolve the promise early (the dialog disables its
    // button on isLoading, this covers the same-tick edge).
    if (runningRef.current) return
    runningRef.current = true
    const action = actionRef.current
    actionRef.current = null
    let completed = true
    if (action) {
      try {
        // Awaited by the dialog's own handleConfirm, so its isLoading spinner
        // shows for the duration and the dialog closes only when this settles.
        await action()
      } catch {
        // The action surfaces its own error (toast); resolving false here
        // keeps the caller's post-confirm tail from running on a failure.
        completed = false
      }
    }
    if (resolveRef.current) {
      resolveRef.current(completed)
      resolveRef.current = null
    }
    runningRef.current = false
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
