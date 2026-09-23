"use client"

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { useToast } from "@/components/ui/use-toast"
import { isValidElement, type ReactNode } from "react"
import { getErrorMessage } from "@/lib/errors/get-error-message"

/**
 * The Toaster lives in the ROOT layout, as a sibling of {children}. A throw in
 * here escapes every segment error boundary and lands on global-error, which
 * blanks the entire app. Callers that hand over an unchecked `await
 * res.json()` field pass the canonical `{ code, message, … }` envelope object
 * rather than a string, and React throws "Objects are not valid as a React
 * child" on it.
 *
 * Individual call sites are still expected to run their errors through
 * getErrorMessage. This is the choke point that keeps the one that forgets
 * from taking the whole app down with it.
 */
export function coerceToastNode(value: ReactNode): ReactNode {
  if (value == null || typeof value === "string" || typeof value === "number") return value
  if (typeof value === "boolean") return null
  if (isValidElement(value)) return value
  // Arrays are legitimate React children, but an unchecked JSON array can hold
  // objects, and one of those still throws. Coerce members too; elements pass
  // through by identity so their keys survive.
  if (Array.isArray(value)) return value.map(coerceToastNode)
  return getErrorMessage(value)
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        const safeTitle = coerceToastNode(title)
        const safeDescription = coerceToastNode(description)
        return (
          <Toast key={id} {...props}>
            <div className="grid gap-1">
              {safeTitle && <ToastTitle>{safeTitle}</ToastTitle>}
              {safeDescription && (
                <ToastDescription>{safeDescription}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
