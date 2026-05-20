'use client'

import { cn } from '@/lib/utils'

interface Props {
  // When true, render the dot. The parent owns the "did this value come from
  // AI extraction?" question — usually by comparing the current input value
  // against the originally-prefilled value, and clearing the flag once the
  // user edits the field.
  active: boolean
  // Visible label next to the dot. Defaults to none (just the dot, with
  // tooltip text on hover). Set to "AI-fyllt" or similar when the field
  // has room.
  label?: string
  className?: string
  // Tooltip / aria-label for the dot.
  title?: string
}

// Tiny indicator that a form field's value was pre-filled by the AI
// extraction pipeline. Sits to the right of the field label or inside the
// input's right padding. Fades when the user edits the field — see how
// supplier-invoices/new wires it.
//
// Design: a small filled dot, success color when the extraction succeeded.
// Optional uppercase micro-label for forms where space allows.
export default function AiFilledIndicator({ active, label, className, title }: Props) {
  if (!active) return null
  return (
    <span
      title={title ?? 'Värdet är ifyllt av AI baserat på dokumentet'}
      className={cn(
        'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground',
        className,
      )}
    >
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
      {label ?? <span className="sr-only">AI-fyllt</span>}
    </span>
  )
}
