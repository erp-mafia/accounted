'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Right slide-over for reviewing an object (UI-migration convention 13):
 * a 480px panel inset 18px from the frame edge, rounded, with veil, Esc
 * and click-outside. Create/confirm flows use the centered dialog instead;
 * this is the review surface (e.g. the Granskning detail).
 */
const SlideOver = DialogPrimitive.Root
const SlideOverTrigger = DialogPrimitive.Trigger
const SlideOverClose = DialogPrimitive.Close

const SlideOverContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/30 dark:bg-black/50',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed top-[18px] right-[18px] bottom-[18px] z-50 flex w-[480px] max-w-[calc(100vw-36px)] flex-col',
        'rounded-xl border border-border bg-background shadow-[var(--shadow-lg)]',
        'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-full data-[state=open]:fade-in-0 data-[state=open]:duration-300 data-[state=open]:ease-[cubic-bezier(0.32,0.72,0,1)]',
        'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right-full data-[state=closed]:fade-out-0 data-[state=closed]:duration-200 data-[state=closed]:ease-in',
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
SlideOverContent.displayName = 'SlideOverContent'

/**
 * Header block: kicker line (actor · risk · time), serif title, close
 * button. Body scrolls; header and footer stay put.
 */
function SlideOverHeader({
  kicker,
  title,
  className,
}: {
  kicker?: React.ReactNode
  title: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex-shrink-0 border-b border-border px-6 py-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {kicker && (
            <div className="mb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              {kicker}
            </div>
          )}
          <DialogPrimitive.Title className="font-display text-lg leading-6 tracking-tight">
            {title}
          </DialogPrimitive.Title>
        </div>
        <DialogPrimitive.Close
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </div>
    </div>
  )
}

function SlideOverBody({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto scrollbar-visible px-6 py-4', className)}>
      {children}
    </div>
  )
}

function SlideOverFooter({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3',
        className,
      )}
    >
      {children}
    </div>
  )
}

export {
  SlideOver,
  SlideOverTrigger,
  SlideOverClose,
  SlideOverContent,
  SlideOverHeader,
  SlideOverBody,
  SlideOverFooter,
}
