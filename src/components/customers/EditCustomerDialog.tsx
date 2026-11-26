'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import CustomerForm from '@/components/customers/CustomerForm'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { customerFormInitialData } from '@/lib/customers/customer-form-initial-data'
import { getErrorMessage, getResponseErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { fetchCustomer } from '@/lib/reference-data/fetchers'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import type { CreateCustomerInput, Customer } from '@/types'

interface EditCustomerDialogProps {
  customerId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** After a save: the dialog has closed, the cached register is refreshed next. */
  onSaved?: () => void
}

/**
 * The customer card's edit dialog, for every place a card is edited from (the
 * customer page, the invoice editor). Each opening reads the full row by id,
 * never a list row a host happens to hold: the form saves every field, so a
 * column missing from its starting values would be cleared
 * (lib/customers/customer-form-initial-data.ts).
 */
export function EditCustomerDialog({ customerId, open, onOpenChange, onSaved }: EditCustomerDialogProps) {
  const t = useTranslations('customer_detail')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{t('edit_dialog_title')}</DialogTitle>
        </DialogHeader>
        {/* Mounted only while the dialog is open, and once per customer, so it
            starts empty every time and never saves one card's values to another. */}
        <EditCustomerBody
          key={customerId}
          customerId={customerId}
          onClose={() => onOpenChange(false)}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  )
}

function EditCustomerBody({
  customerId,
  onClose,
  onSaved,
}: {
  customerId: string
  onClose: () => void
  onSaved?: () => void
}) {
  const t = useTranslations('customer_detail')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [isUpdating, setIsUpdating] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchCustomer(customerId)
      .then((row) => {
        if (cancelled) return
        if (row) setCustomer(row)
        else setLoadFailed(true)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [customerId, loadAttempt])

  async function handleUpdate(data: CreateCustomerInput) {
    setIsUpdating(true)
    try {
      const response = await fetch(`/api/customers/${encodeURIComponent(customerId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        // The server's sentence says why (a duplicate org number, a field it
        // refused), not only that it failed.
        toast({
          title: t('update_failed_title'),
          description: await getResponseErrorMessage(response, 'customer', errorLocale),
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('updated_title'),
        description: data.name,
      })
      onClose()
      onSaved?.()
      // Every customer picker reads the cached register: refresh it now.
      void invalidateReferenceData('ref:customers')
    } catch (error) {
      toast({
        title: t('update_failed_title'),
        description: getErrorMessage(error, { context: 'customer', locale: errorLocale, fallback: t('retry') }),
        variant: 'destructive',
      })
    } finally {
      setIsUpdating(false)
    }
  }

  if (customer) {
    return <CustomerForm onSubmit={handleUpdate} isLoading={isUpdating} initialData={customerFormInitialData(customer)} />
  }
  if (loadFailed) {
    return (
      <LoadError
        title={t('load_failed_title')}
        onRetry={() => {
          setLoadFailed(false)
          setLoadAttempt((n) => n + 1)
        }}
      />
    )
  }
  return (
    <LateReveal className="space-y-4 py-2" role="status" aria-label={tCommon('loading')}>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-24 w-full" />
    </LateReveal>
  )
}
