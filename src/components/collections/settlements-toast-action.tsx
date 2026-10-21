'use client'

import Link from 'next/link'
import { ToastAction, type ToastActionElement } from '@/components/ui/toast'

/** The refusal a generic storno of a collected payment answers with (lib/errors/structured-errors.ts). */
export const COLLECTED_PAYMENT_STORNO_REFUSAL = 'CANNOT_REVERSE_COLLECTED_PAYMENT'

/**
 * The toast action that leads a refused storno of a collected payment to
 * Avräkningar, where "Bokför om" is the sanctioned correction. Undefined for
 * any other answer.
 */
export function settlementsToastAction(body: unknown, label: string): ToastActionElement | undefined {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code
  if (code !== COLLECTED_PAYMENT_STORNO_REFUSAL) return undefined
  return (
    <ToastAction altText={label} asChild>
      <Link href="/invoices/settlements">{label}</Link>
    </ToastAction>
  )
}
