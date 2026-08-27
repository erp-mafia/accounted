"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
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
        // --agent-dock-w is set on <html> only while the sheet is docked open
        // (AgentSheetProvider), so with the sheet closed or floating this is
        // exactly left-[50%]. Without it a wide dialog centers under the
        // sheet and its right edge becomes unreachable (sheet is z-60).
        "fixed left-[calc((100vw-var(--agent-dock-w,0px))/2)] top-[50%] z-50 grid grid-cols-[minmax(0,1fr)] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-[var(--shadow-md)] max-h-[calc(100dvh-2rem)] overflow-y-auto scrollbar-visible data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-98 data-[state=open]:zoom-in-98 sm:rounded-xl",
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

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
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2 sm:gap-0",
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
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
