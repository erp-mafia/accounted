"use client"

import * as React from "react"
import * as ToastPrimitives from "@radix-ui/react-toast"
import { cva, type VariantProps } from "class-variance-authority"
import { XMarkIcon } from '@/components/icons'
import { cn } from "@/lib/utils"

const ToastProvider = ToastPrimitives.Provider

// Toasts open just under the 48px top bar, never on it: the page's primary
// action sits top-right in that bar (design.md conventions 2 and 9), and a
// toast in the same corner covered it until it faded (crm#245). From md up
// the dashboard panel starts 10px down and ends --agent-dock-w from the right
// (MAIN_PANEL_CLASS in app/(dashboard)/layout.tsx), so the viewport follows
// the panel and a docked assistant is never covered either.
const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    className={cn(
      "fixed top-12 z-[100] flex max-h-screen w-full flex-col p-4 sm:right-4 sm:bottom-auto sm:flex-col md:top-[calc(10px+3rem)] md:right-[var(--agent-dock-w)] md:max-w-[420px]",
      className
    )}
    {...props}
  />
))
ToastViewport.displayName = ToastPrimitives.Viewport.displayName

const toastVariants = cva(
  // Stil v3: a compact floating layer (10px radius, float shadow, 13px),
  // for undoable successes first of all: the action is the quiet Ångra.
  // Failures keep the same surface and set the title in the red ink instead
  // of painting the whole toast.
  "group pointer-events-auto relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-pop bg-popover py-2.5 pl-3.5 pr-9 text-[13px] text-popover-foreground shadow-float transition-transform data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-0 max-sm:data-[state=open]:slide-in-from-top-full max-sm:data-[state=closed]:slide-out-to-top-full sm:data-[state=open]:slide-in-from-right-full sm:data-[state=closed]:slide-out-to-right-full",
  {
    variants: {
      variant: {
        default: "",
        destructive: "destructive group",
        success: "success group",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => {
  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  )
})
Toast.displayName = ToastPrimitives.Root.displayName

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      "inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2.5 text-[13px] font-medium text-strong ring-offset-background transition-[background-color,transform] duration-150 hover:bg-secondary/60 active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-40",
      className
    )}
    {...props}
  />
))
ToastAction.displayName = ToastPrimitives.Action.displayName

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      "absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 group-hover:opacity-100 pointer-coarse:opacity-100",
      className
    )}
    toast-close=""
    {...props}
  >
    <XMarkIcon className="h-3.5 w-3.5" />
  </ToastPrimitives.Close>
))
ToastClose.displayName = ToastPrimitives.Close.displayName

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  // Deliberately NOT data-ph-unmask: toast titles and descriptions
  // interpolate user data (deadline titles, account names) at too many call
  // sites to audit, so toasts stay masked in session replays. The variant
  // styling still shows success/failure in the replay.
  <ToastPrimitives.Title
    ref={ref}
    className={cn("text-[13px] font-medium text-strong group-[.destructive]:text-destructive", className)}
    {...props}
  />
))
ToastTitle.displayName = ToastPrimitives.Title.displayName

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    className={cn("text-[12px] leading-4 text-muted-foreground", className)}
    {...props}
  />
))
ToastDescription.displayName = ToastPrimitives.Description.displayName

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

type ToastActionElement = React.ReactElement<typeof ToastAction>

export {
  type ToastProps,
  type ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
}
