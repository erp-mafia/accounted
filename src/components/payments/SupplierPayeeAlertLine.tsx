'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { PayeeChangeDialog } from './PayeeChangeDialog'
import { fetchInvoicePayee, type InvoicePayeeView } from './payee-change-client'

/**
 * The supplier invoice page's one ochre sentence about the bank details the
 * invoice states, when they hold its payment back: new details nobody has
 * approved, or details a person rejected. "Granska" opens the decision.
 * Renders nothing otherwise, and nothing for a paid or credited invoice.
 */
export function SupplierPayeeAlertLine({ supplierInvoiceId }: { supplierInvoiceId: string }) {
  const t = useTranslations('supplier_payee_change')
  const { canWrite } = useCanWrite()
  const [view, setView] = useState<InvoicePayeeView | null>(null)
  const [open, setOpen] = useState(false)
  /** Bumped after a decision, to read the invoice's view again. */
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetchInvoicePayee(supplierInvoiceId)
      .then((next) => {
        if (!cancelled) setView(next)
      })
      .catch(() => {
        // Advice on this page, never a gate here: the payment paths hold the invoice themselves.
        if (!cancelled) setView(null)
      })
    return () => {
      cancelled = true
    }
  }, [supplierInvoiceId, version])

  if (!view || !view.hold || !view.payable) return null

  const sentence =
    view.hold === 'payee_rejected'
      ? t('line_rejected', { payee: view.new_payee ?? '' })
      : view.alert === 'new_supplier_account'
        ? t('line_new', { payee: view.new_payee ?? '' })
        : t('line_changed', { payee: view.new_payee ?? '', card: view.old_payee ?? '' })

  return (
    <>
      <AttnLine action={canWrite ? { label: t('review'), onClick: () => setOpen(true) } : undefined}>{sentence}</AttnLine>
      {open && (
        <PayeeChangeDialog
          supplierInvoiceId={supplierInvoiceId}
          initial={view}
          onOpenChange={setOpen}
          onDecided={() => setVersion((v) => v + 1)}
        />
      )}
    </>
  )
}
