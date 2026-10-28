'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useTranslations } from 'next-intl'
import { XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDashShellInert } from './dialog'

/**
 * Right slide-over for reviewing an object (UI-migration convention 13):
 * a 480px panel inset 18px from the frame edge, rounded, with veil, Esc
 * and click-outside. Create/confirm flows use the centered dialog instead;
 * this is the review surface (e.g. the Granskning detail).
 *
 * Non-modal, so the agent sheet (fixed z-[60], portaled outside) stays
 * usable beside a review. A modal Radix root sets pointer-events: none on
 * <body>, which killed the sheet, while this right-anchored panel sat under
 * the docked sheet with its own buttons hidden: neither could be used
 * (crm#1106). Page modality is restored by hand in SlideOverContent (veil,
 * inert dash shell), the panel sits left of a docked sheet, and the sheet
 * counts as inside. Same convention as the non-modal booking dialogs.
 */
function SlideOver(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root modal={false} {...props} />
}
const SlideOverTrigger = DialogPrimitive.Trigger
const SlideOverClose = DialogPrimitive.Close

/** Holds #dash-shell inert while the panel is mounted (see useDashShellInert). */
function DashShellInert() {
  useDashShellInert(true)
  return null
}

const SlideOverContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onInteractOutside, onFocusOutside, ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/* A non-modal root renders no Radix Overlay, so the veil is ours. z-40
        sits under the panel (z-50), the assistant trigger (z-[45]) and the
        sheet (z-[60]); a click on it is outside the panel and closes it. */}
    <div aria-hidden="true" className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50 animate-in fade-in-0" />
    <DialogPrimitive.Content
      ref={ref}
      // Companion overlays portaled to <body> (data-dialog-companion) and the
      // agent sheet and its trigger (data-agent-ui) count as inside, as in
      // DialogContent: writing to the assistant must never close a review.
      onInteractOutside={(event) => {
        onInteractOutside?.(event)
        const target = event.target
        if (target instanceof Element && target.closest('[data-dialog-companion], [data-agent-ui]')) {
          event.preventDefault()
        }
      }}
      // Focus moving elsewhere (the assistant, a confirm dialog opened from
      // the panel, a toast) never closes it, as when the panel was modal:
      // closing takes the X, Esc or a click on the veil.
      onFocusOutside={(event) => {
        onFocusOutside?.(event)
        event.preventDefault()
      }}
      className={cn(
        // md: right edge and width stop at a docked agent sheet, the way
        // DialogContent centers beside it. --agent-sheet-w exists only while
        // the sheet is docked open, so closed or floating this is the plain
        // 18px inset. Below md the sheet covers the screen and is closable.
        'fixed top-[18px] right-[18px] bottom-[18px] z-50 flex w-[480px] max-w-[calc(100vw-36px)] flex-col',
        'md:right-[calc(18px+var(--agent-sheet-w,0px))] md:max-w-[calc(100vw-36px-var(--agent-sheet-w,0px))]',
        'rounded-xl border border-border bg-background shadow-[var(--shadow-lg)]',
        'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-full data-[state=open]:fade-in-0 data-[state=open]:duration-300 data-[state=open]:ease-drawer',
        'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right-full data-[state=closed]:fade-out-0 data-[state=closed]:duration-150 data-[state=closed]:ease-drawer',
        className,
      )}
      {...props}
    >
      <DashShellInert />
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
  closeLabel,
}: {
  kicker?: React.ReactNode
  title: React.ReactNode
  className?: string
  closeLabel?: string
}) {
  const t = useTranslations('common')
  return (
    <div className={cn('flex-shrink-0 border-b border-border px-6 py-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {kicker && (
            <div className="mb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              {kicker}
            </div>
          )}
          {/* break-words: a title naming a file has no space to wrap at and
              ran past the panel's edge (crm#1003). */}
          <DialogPrimitive.Title className="break-words font-display text-lg leading-6 tracking-tight">
            {title}
          </DialogPrimitive.Title>
        </div>
        {/* The shared icon-sm button (40px on touch) with a label even when
            the caller passes none; pointer-events-auto so one click closes
            the panel while a select inside it is open (see DialogCloseButton
            in ./dialog). */}
        <DialogPrimitive.Close asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={closeLabel ?? t('close')}
            data-attr="dialog-close"
            className="pointer-events-auto flex-shrink-0 text-muted-foreground"
          >
            <XMarkIcon className="h-4 w-4" />
          </Button>
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
