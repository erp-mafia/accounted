'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { LatePaidInvoice } from '@/lib/invoices/late-payment-interest-report'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'

interface Group {
  key: string
  customerName: string | null
  currency: string
  invoiceIds: string[]
  interest: number
}

/** One draft per customer and currency, as the server makes them. */
function groupRows(rows: LatePaidInvoice[]): Group[] {
  const groups = new Map<string, Group>()
  for (const row of rows) {
    const key = `${row.customer_id}\u0000${row.currency}`
    const group = groups.get(key) ?? { key, customerName: row.customer_name, currency: row.currency, invoiceIds: [], interest: 0 }
    group.invoiceIds.push(row.invoice_id)
    group.interest = roundOre(group.interest + row.interest)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => (a.customerName ?? '').localeCompare(b.customerName ?? '') || a.currency.localeCompare(b.currency))
}

interface CreatedDraft {
  invoice_id: string
}

/**
 * Skapa räntefaktura: the customers whose late-paid invoices can be charged
 * (isLateInterestChargeable), each ticked, and one draft per ticked customer
 * and currency once confirmed (POST /api/invoices/late-payment-interest/invoices).
 * The dialog states the outcome before the click: drafts, on 8313 without VAT,
 * nothing sent or booked.
 */
export function CreateLateInterestInvoicesDialog({
  open,
  onOpenChange,
  rows,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The chargeable rows the page shows. */
  rows: LatePaidInvoice[]
  onCreated: () => void
}) {
  const t = useTranslations('latePaymentInterest')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const router = useRouter()
  const { toast } = useToast()
  const groups = useMemo(() => groupRows(rows), [rows])
  const [unticked, setUnticked] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (open) setUnticked(new Set())
  }, [open])

  const picked = groups.filter((group) => !unticked.has(group.key))

  async function create() {
    let response: Response
    let json: { data?: { created: CreatedDraft[]; failed: Array<{ code: string }> } } | null = null
    try {
      response = await fetch('/api/invoices/late-payment-interest/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_ids: picked.flatMap((group) => group.invoiceIds) }),
      })
      json = await response.json().catch(() => null)
    } catch (error) {
      toast({ title: t('create_failed_title'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
      // The drafts may have been made before the answer was lost: read the
      // page again so it shows what is charged now.
      onCreated()
      return
    }
    if (!response.ok || !json?.data) {
      toast({
        title: t('create_failed_title'),
        description: getErrorMessage(json, { locale, statusCode: response.status }),
        variant: 'destructive',
      })
      onCreated()
      return
    }
    const { created, failed } = json.data
    const target = created.length === 1 ? `/invoices/${created[0].invoice_id}` : '/invoices?tab=draft'
    toast({
      title: t('created_title', { count: created.length }),
      description: failed.length > 0 ? t('created_some_failed', { count: failed.length }) : t('created_description'),
      variant: failed.length > 0 ? 'destructive' : undefined,
      action: (
        <ToastAction altText={t('created_open')} onClick={() => router.push(target)}>
          {t('created_open')}
        </ToastAction>
      ),
    })
    onCreated()
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('create_title')}
      description={t('create_description')}
      confirmLabel={t('create_confirm', { count: picked.length })}
      confirmDisabled={picked.length === 0}
      onConfirm={create}
    >
      <ul className="max-h-72 space-y-1 overflow-y-auto text-[13px]">
        {groups.map((group) => {
          const checked = !unticked.has(group.key)
          const id = `late-interest-${group.key.replace(/[^a-zA-Z0-9]/g, '-')}`
          return (
            <li key={group.key} className="flex min-h-9 items-center gap-3">
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(next) =>
                  setUnticked((current) => {
                    const copy = new Set(current)
                    if (next === true) copy.delete(group.key)
                    else copy.add(group.key)
                    return copy
                  })
                }
              />
              <label htmlFor={id} className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                <span className="min-w-0 truncate" data-ph-mask>
                  {group.customerName ?? ''}
                  <span className="ml-2 text-muted-foreground">{t('create_group_invoices', { count: group.invoiceIds.length })}</span>
                </span>
                <span className="shrink-0 tabular-nums">{formatCurrency(group.interest, group.currency)}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </ConfirmDialog>
  )
}
