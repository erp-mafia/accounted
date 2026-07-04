'use client'

import { MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAgentSheet } from './AgentSheetProvider'

interface Props {
  intentId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intentArgs?: Record<string, any>
  contextRef?: string
  // Override the auto-derived "Fråga [namn]" label when the page wants
  // something more contextual (e.g. "Förklara denna siffra"). Most surfaces
  // should leave this unset.
  label?: string
  size?: 'sm' | 'default' | 'lg'
  variant?: 'outline' | 'default' | 'ghost' | 'secondary'
  className?: string
}

// Single source of truth for the in-page "Fråga [namn]" affordance. Every
// page-header button across the dashboard (invoice form, supplier invoice,
// bookkeeping, year-end, VAT report, KPI, …) routes through this component
// so they share the same icon size, label format, spacing, and resolved
// agent name. The transaction-row icon button stays separate: it's a
// different UX (icon-only, ghost) embedded inside a row's action group.
export default function AgentSparkleButton({
  intentId,
  intentArgs,
  contextRef,
  label,
  size = 'sm',
  variant = 'outline',
  className,
}: Props) {
  const { openAgentSheet, identity } = useAgentSheet()
  // Same gate as AgentTrigger: hide all "Fråga …" affordances until the
  // user has finished /onboarding/agent.
  if (!identity.isVerified) return null
  const name = identity.displayName?.trim() || 'min assistent'
  const resolvedLabel = label ?? `Fråga ${name}`

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn('shrink-0', className)}
      onClick={() =>
        openAgentSheet({
          intentId,
          intentArgs,
          contextRef,
        })
      }
    >
      <MessageCircle className="mr-2 h-4 w-4" />
      {resolvedLabel}
    </Button>
  )
}
