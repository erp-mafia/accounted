'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { resolveIcon } from '@/lib/extensions/icon-resolver'

interface ExtensionUpsellStateProps {
  iconName?: string
  title: string
  description: string
  ctaLabel: string
  ctaHref: string
}

/**
 * Paywall state for a gated extension workspace, rendered when the active
 * company lacks the required capability.
 *
 * This is a client component on purpose: the server page cannot pass a
 * resolved icon component into the 'use client' EmptyState (React cannot
 * serialize a component across the RSC boundary; doing so 500s the page).
 * The page passes the icon NAME as a plain string and this wrapper resolves
 * it client-side, same as DashboardNav and the command palette do.
 * Every prop here must stay plain-serializable (strings only).
 */
export function ExtensionUpsellState({
  iconName,
  title,
  description,
  ctaLabel,
  ctaHref,
}: ExtensionUpsellStateProps) {
  const Icon = iconName ? resolveIcon(iconName) : undefined
  return (
    <EmptyState icon={Icon} title={title} description={description}>
      <Link href={ctaHref}>
        <Button>{ctaLabel}</Button>
      </Link>
    </EmptyState>
  )
}
