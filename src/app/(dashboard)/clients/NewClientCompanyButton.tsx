'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import NewClientCompanyDialog from '@/components/dashboard/NewClientCompanyDialog'

/**
 * "Nytt klientbolag" (WL-15): header primary action on the cockpit, rendered
 * only for byrå owner/admin (the page checks; the create RPC enforces the
 * same gate in the database). Opens the shared confirm dialog, which routes
 * into company creation with the explicit byrå team binding.
 */
export default function NewClientCompanyButton() {
  const t = useTranslations('clients')
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-2 h-4 w-4" />
        {t('new_client_company')}
      </Button>
      <NewClientCompanyDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
