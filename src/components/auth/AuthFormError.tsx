'use client'

import type { ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'

/**
 * Inline error line for the auth forms (login, register, reset).
 *
 * Auth failures render here, adjacent to the form, instead of in a toast:
 * a toast in the corner auto-dismisses, sits far from the locus of attention,
 * and is easy to miss entirely. Styled as one quiet destructive sentence with
 * an icon, mirroring the AttnLine pattern, never as a boxed banner: the box
 * reads louder than the message and breaks the panel's rhythm. role="alert"
 * makes screen readers announce the message when it appears.
 */
export function AuthFormError({
  message,
  action,
}: {
  message: string
  action?: ReactNode
}) {
  return (
    <p
      role="alert"
      className="animate-fade-in flex items-start gap-2 text-[13px] leading-5 text-destructive"
    >
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        {message}
        {action && <> {action}</>}
      </span>
    </p>
  )
}
