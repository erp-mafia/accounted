'use client'

import { Loader2, ShieldAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { SessionTimeoutReason } from '@/lib/auth/session-timeout-shared'

export function SessionTimeoutModal({
  reason,
  seconds,
  isExtending,
  onContinue,
}: {
  reason: SessionTimeoutReason
  seconds: number
  isExtending: boolean
  onContinue: () => void
}) {
  const t = useTranslations('session_timeout')

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="max-w-md [&>button]:hidden"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-attn">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </div>
          <DialogTitle>{t('warning_title')}</DialogTitle>
          <DialogDescription>
            {reason === 'idle'
              ? t('idle_warning', { seconds })
              : t('absolute_warning', { seconds })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onContinue} disabled={isExtending} autoFocus>
            {isExtending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {reason === 'idle' ? t('continue') : t('sign_in_again')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
