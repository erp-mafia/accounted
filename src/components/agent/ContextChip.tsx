'use client'

import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { contextRefToTarget } from '@/lib/agent/intents/route-mapping'
import { cn } from '@/lib/utils'

/**
 * What a conversation is anchored to, as a chip.
 *
 * `agent_conversations.context_ref` has been written since the first intents
 * shipped. The panel ignored it entirely, and /chat printed it raw, so a
 * resumed thread's subtitle read "invoice:5f3a-9c21-...": a database
 * identifier shown to an accountant. Both surfaces now render the same chip,
 * which names the thing and links to it.
 *
 * Kind-agnostic on purpose (plan seam 8.4): the mapping lives in
 * route-mapping.ts, so teaching every surface about a new ref kind is one
 * entry in that map and no component change. A kind the map does not know
 * yet, a flow run for instance, renders nothing rather than a broken link.
 */
export default function ContextChip({
  contextRef,
  className,
}: {
  contextRef: string | null | undefined
  className?: string
}) {
  const target = contextRefToTarget(contextRef)
  if (!target) return null

  const shape =
    'inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground'

  // Not every context has a page to go to: the document inbox is an extension
  // route, and core cannot hardcode a path that exists only when the extension
  // is enabled. Naming it without linking beats a link that 404s.
  if (!target.href) {
    return (
      <span className={cn(shape, className)}>
        <span className="truncate">{target.label}</span>
      </span>
    )
  }

  return (
    <Link
      href={target.href}
      className={cn(
        shape,
        'hover:bg-secondary hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <span className="truncate">{target.label}</span>
      <ArrowUpRight className="h-3 w-3 shrink-0" />
    </Link>
  )
}
