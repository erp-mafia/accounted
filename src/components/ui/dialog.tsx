"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { useTranslations } from "next-intl"
import { XMarkIcon } from '@/components/icons'
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/50 dark:bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onInteractOutside, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // Companion overlays (AccountCombobox's dropdown, HelpPopover panels)
      // are portaled to document.body so this content's overflow-y-auto can
      // never clip them. DOM-wise that puts them OUTSIDE the dialog, so Radix
      // would otherwise dismiss the dialog on a pointerdown inside them:
      // anything marked data-dialog-companion counts as inside. The agent
      // sheet and its trigger (data-agent-ui) count as inside for the same
      // reason: writing to the assistant must never dismiss a dialog.
      onInteractOutside={(event) => {
        onInteractOutside?.(event)
        const target = event.target
        if (target instanceof Element && target.closest('[data-dialog-companion], [data-agent-ui]')) {
          event.preventDefault()
        }
      }}
      className={cn(
        // grid-cols-[minmax(0,1fr)]: the implicit auto track sizes to the widest
        // child's min-content, and nowrap text (truncate) counts at full width
        // there, so one long description widens every sibling past the dialog
        // edge. minmax(0,1fr) caps the track at the content box.
        // left: centered in the viewport MINUS the docked agent sheet.
        // --agent-sheet-w exists as an inline var on <html> ONLY while the
        // sheet is docked open (AgentSheetProvider); closed/floating falls to
        // the 0px fallback, making this exactly left-[50%]. Do NOT read
        // --agent-dock-w here: globals.css seeds that at 10px permanently.
        // Without the shift a wide dialog centers under the sheet and its
        // right edge becomes unreachable (sheet is z-60).
        "fixed left-[calc((100vw-var(--agent-sheet-w,0px))/2)] top-[50%] z-50 grid grid-cols-[minmax(0,1fr)] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-[var(--shadow-md)] max-h-[calc(100dvh-2rem)] overflow-y-auto scrollbar-visible data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-98 data-[state=open]:zoom-in-98 sm:rounded-xl",
        className
      )}
      {...props}
    >
      {children}
      <DialogCloseButton />
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

/**
 * The X in a dialog's corner. It was a bare 16px icon, and session replays
 * showed the first click on it doing nothing: a click a few px beside the
 * icon missed it, and with a select or popover open inside the dialog Radix
 * handed the click to that inner layer, which only closed itself. Now it is
 * the shared icon-sm button (32px, 40px on touch) centred where the icon
 * sat, and pointer-events-auto lets it take the click while an inner layer
 * holds pointer events, so one click closes the dialog. data-attr names it
 * for PostHog autocapture (the project's data attribute), so its rage
 * clicks can be counted across icon changes.
 */
function DialogCloseButton() {
  const t = useTranslations("common")
  return (
    <DialogPrimitive.Close asChild>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("close")}
        data-attr="dialog-close"
        className="pointer-events-auto absolute right-2 top-2 text-muted-foreground"
      >
        <XMarkIcon className="h-4 w-4" />
      </Button>
    </DialogPrimitive.Close>
  )
}

/**
 * Backdrop for non-modal dialogs. Radix renders no Overlay when the root has
 * `modal={false}`, so dialogs that opt out of modality (to keep the agent
 * sheet interactive above them) render this alongside DialogContent to keep
 * the standard veil. z-40 sits under DialogContent (z-50) and the agent
 * sheet (z-60).
 */
const DialogVeil = () => (
  <DialogPortal>
    <div
      aria-hidden="true"
      className="fixed inset-0 z-40 bg-black/50 dark:bg-black/60 animate-in fade-in-0"
    />
  </DialogPortal>
)

// Ref-counted so overlapping non-modal dialogs (e.g. the template picker
// closing in the same commit as the booking dialog opens) cannot fight over
// the flag: the shell stays inert until the LAST open dialog releases it.
let dashShellInertCount = 0

/**
 * Hand-rolled page modality for `modal={false}` dialogs. Radix non-modal mode
 * drops the focus trap, aria-hiding, and body pointer-events lock, so the
 * page behind the DialogVeil would stay keyboard/AT/tap-reachable. `inert` on
 * the dash shell blocks all of that while the agent sheet and its trigger
 * (both outside the shell) stay live. Pair with DialogVeil.
 */
const useDashShellInert = (open: boolean) => {
  React.useEffect(() => {
    if (!open) return
    const shell = document.getElementById('dash-shell')
    if (!shell) return
    dashShellInertCount++
    shell.inert = true
    return () => {
      dashShellInertCount--
      if (dashShellInertCount <= 0) shell.inert = false
    }
  }, [open])
}

/**
 * onEscapeKeyDown for a dialog that holds a form. Escape closes it, as every
 * overlay does, while nothing would be lost. It is held while the form has
 * unsaved input (closing is then explicit: the header X), and while a
 * companion panel is open (a portaled combobox list or help popover, marked
 * data-dialog-companion): that Escape is meant for the panel, which closes
 * itself. Nested Radix layers (a select, a confirm dialog) never reach this
 * handler: Radix hands Escape to the topmost layer only. An Escape pressed in
 * the assistant beside a non-modal dialog (data-agent-ui) is the assistant's,
 * as a click there is (see onInteractOutside above).
 */
function holdEscapeWhileUnsaved(event: KeyboardEvent, hasUnsavedInput: boolean): void {
  const inAssistant = !!(event.target as Element | null)?.closest?.('[data-agent-ui]')
  if (hasUnsavedInput || inAssistant || document.querySelector('[data-dialog-companion]')) {
    event.preventDefault()
  }
}

// A press that edits without a change event: a button (add or remove a row,
// a checkbox, a combobox's option), a list option or a menu item.
const EDITING_CONTROL = 'button, [role="option"], [role^="menuitem"], [role="radio"], [role="checkbox"], [role="switch"]'

/**
 * "Has the person changed anything since the dialog opened", for a form
 * dialog where "has content" cannot tell: it opens filled (a bank row's
 * proposal, a saved employee), keeps input outside one form state, or reads
 * uncontrolled fields only on submit. Spread `editProps` on an element around
 * the form that mounts and unmounts with the dialog content (so each open
 * starts untouched; className "contents" adds no box) and pass `edited()` to
 * holdEscapeWhileUnsaved.
 *
 * It turns on at the first typed or picked value (a trusted change event;
 * the change events Radix dispatches to sync its hidden inputs are not the
 * person's), the first press of a control or list option, Enter or Space, a
 * double click (fill balance) or a drop, and stays on: erring towards holding
 * is the safe side, the header X always closes. React events bubble through
 * portals, so a pick in a portaled combobox list counts.
 */
function createEditTracker() {
  let edited = false
  const mark = () => {
    edited = true
  }
  return {
    edited: () => edited,
    editProps: {
      // Called with the element on mount and with null on unmount.
      ref: () => {
        edited = false
      },
      onChange: (event: { nativeEvent: Event }) => {
        if (event.nativeEvent.isTrusted) mark()
      },
      onPointerDown: (event: { target: EventTarget | null }) => {
        if ((event.target as Element | null)?.closest?.(EDITING_CONTROL)) mark()
      },
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter' || event.key === ' ') mark()
      },
      onDoubleClick: mark,
      onDrop: mark,
    },
  }
}

/** createEditTracker for one dialog host, stable across renders. */
function useEditedSinceOpen() {
  const [tracker] = React.useState(createEditTracker)
  return tracker
}

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      // On a phone the footer stacks full-width 44px buttons, so no call site
      // patches its own touch target.
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2 sm:gap-0 max-sm:[&>button]:h-11 max-sm:[&>button]:w-full",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  // data-ph-unmask: dialog titles are static i18n chrome in session replays;
  // a title carrying user data adds data-ph-mask at the call site.
  <DialogPrimitive.Title
    ref={ref}
    data-ph-unmask=""
    className={cn(
      "break-words text-lg leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-ph-unmask=""
    className={cn("break-words text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogVeil,
  useDashShellInert,
  holdEscapeWhileUnsaved,
  createEditTracker,
  useEditedSinceOpen,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
