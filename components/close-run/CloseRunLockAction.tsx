'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { formatDate } from '@/lib/utils'

/**
 * The run's terminal step: stage the month lock as a HIGH-risk pending
 * operation. Approval happens in Granskning (/pending): this button never
 * locks anything directly (maker-checker by construction). Staging is
 * allowed with open blockers (the executor re-gates at commit), but the
 * copy makes the state explicit.
 */
export function CloseRunLockAction({
  month,
  lockDate,
  ready,
  pendingLockStaged,
}: {
  month: string
  lockDate: string
  ready: boolean
  pendingLockStaged: boolean
}) {
  const t = useTranslations('close_run')
  const { toast } = useToast()
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function handleStage() {
    setPending(true)
    try {
      const res = await fetch('/api/close-run/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: body?.error?.message ?? t('stage_failed'),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('staged_toast') })
      router.refresh()
    } catch {
      toast({ title: t('stage_failed'), variant: 'destructive' })
    } finally {
      setPending(false)
    }
  }

  if (pendingLockStaged) {
    return (
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t('staged_notice')}</p>
        <Link
          href="/pending"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors duration-150"
        >
          {t('view_pending')}
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground tabular-nums">
        {ready
          ? t('lock_hint', { date: formatDate(lockDate) })
          : t('lock_hint_blocked', { date: formatDate(lockDate) })}
      </p>
      <Button onClick={handleStage} disabled={pending} aria-busy={pending}>
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          t('lock_action')
        )}
      </Button>
    </div>
  )
}
