'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { reloadTo, signOut } from '@/lib/auth/session-client'
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
  const t = useTranslations('extensions')
  const { toast } = useToast()

  async function handleCreateAccount() {
    setIsLeaving(true)
    // An error here means the server could not be reached, so the anonymous
    // session cookie is still in place (a refused revocation still deletes
    // it, and answers without an error).
    const { error } = await signOut()
    if (error) {
      // Navigating anyway would land on /register with the anonymous session
      // still live, which registers INTO the sandbox: the exact outcome the
      // sign-out exists to prevent. Stay put and let the user retry.
      toast({
        title: t('sandbox_locked_signout_error_title'),
        description: t('sandbox_locked_signout_error_description'),
        variant: 'destructive',
      })
      setIsLeaving(false)
      return
    }
    // Full page load: nothing from the sandbox session stays in memory.
    reloadTo('/register')
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
