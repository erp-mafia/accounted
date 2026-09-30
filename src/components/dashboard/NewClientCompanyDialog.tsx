'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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

/**
 * The "Nytt klientbolag" confirm (WL-15, design convention 10): states that
 * the company is added to the byrå's agreement (+1 on the monthly invoice)
 * BEFORE routing into today's company creation flow with the explicit byrå
 * team binding (/companies/new-client). Shared by every entry point (the
 * cockpit header button, the sidebar user menu) so none of them can skip the
 * confirm. Callers render it only for byrå owner/admin;
 * the page and the create RPC enforce the same gate.
 */
export default function NewClientCompanyDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('clients')
  const router = useRouter()
  const [navigating, setNavigating] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('new_client_company')}</DialogTitle>
          <DialogDescription>{t('added_to_agreement')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={navigating}>
            {t('cancel')}
          </Button>
          <Button
            disabled={navigating}
            onClick={() => {
              setNavigating(true)
              router.push('/companies/new-client')
            }}
          >
            {t('continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
