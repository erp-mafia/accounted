'use client'

import type { ReactNode } from 'react'

/**
 * Inline error alert for the auth forms (login, register, reset).
 *
 * Auth failures render here, adjacent to the fields, instead of in a toast:
 * a toast in the corner auto-dismisses, sits far from the locus of attention,
 * and is easy to miss entirely. role="alert" makes screen readers announce
 * the message when it appears.
 */
export function AuthFormError({
  message,
  action,
}: {
  message: string
  action?: ReactNode
}) {
  return (
    <div
      role="alert"
      className="animate-fade-in rounded-lg border border-destructive/30 bg-destructive/5 p-4"
    >
      <p className="text-sm text-destructive">
        {message}
        {action && <> {action}</>}
      </p>
    </div>
  )
}
