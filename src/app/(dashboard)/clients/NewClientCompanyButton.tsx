'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
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
 * "Nytt klientbolag" (WL-15): header primary action on the cockpit, rendered
 * only for byrå owner/admin (the page checks; the create RPC enforces the
 * same gate in the database). Confirm up front (design convention 10): the
 * dialog states that the company is added to the byrå's agreement (+1 on the
 * monthly invoice) BEFORE routing into today's company creation flow with
 * the explicit byrå team binding (/companies/new-client).
 */
export default function NewClientCompanyButton() {
  const t = useTranslations('clients')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [navigating, setNavigating] = useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-2 h-4 w-4" />
        {t('new_client_company')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('new_client_company')}</DialogTitle>
            <DialogDescription>{t('added_to_agreement')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={navigating}>
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
    </>
  )
}
