'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { createClient } from '@/lib/supabase/client'
import { resolveIcon } from '@/lib/extensions/icon-resolver'

interface ExtensionSandboxLockStateProps {
  iconName?: string
  title: string
  /** One line on what the workspace actually does, so a locked page still explains itself. */
  description: string
  /** Why it is locked here and what unlocks it. */
  note: string
  ctaLabel: string
}

/**
 * Sandbox lock for an extension workspace whose value is an external service
 * (invoice-inbox: AI field extraction plus the forwarding mail address). The
 * sandbox blocks those services outright (lib/sandbox/guard.ts), so an
 * unlocked workspace looks functional and then quietly does nothing.
 *
 * Deliberately not ExtensionUpsellState: an anonymous demo user has no billing
 * to upgrade, they need an account. The CTA signs the anonymous session out
 * first, mirroring SandboxBanner: /register on top of a live anonymous session
 * registers into the sandbox instead of leaving it.
 *
 * Same RSC constraint as ExtensionUpsellState: every prop stays a plain string
 * and the icon is resolved client-side from its name, because passing a
 * resolved component across the server/client boundary 500s the page.
 */
export function ExtensionSandboxLockState({
  iconName,
  title,
  description,
  note,
  ctaLabel,
}: ExtensionSandboxLockStateProps) {
  const [isLeaving, setIsLeaving] = useState(false)
  const router = useRouter()

  async function handleCreateAccount() {
    setIsLeaving(true)
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/register')
  }

  const Icon = iconName ? resolveIcon(iconName) : undefined

  return (
    <EmptyState icon={Icon} title={title} description={description}>
      <div className="flex flex-col items-center gap-4">
        <p className="max-w-sm text-sm text-muted-foreground text-balance">{note}</p>
        <Button onClick={handleCreateAccount} disabled={isLeaving}>
          {ctaLabel}
        </Button>
      </div>
    </EmptyState>
  )
}
