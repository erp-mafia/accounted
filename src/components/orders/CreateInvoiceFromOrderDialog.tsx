'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import CustomerCombobox from '@/components/customers/CustomerCombobox'
import { useCustomers } from '@/lib/reference-data/hooks'
import { cn, formatCurrency } from '@/lib/utils'
import type { WebshopOrder } from '@/types'

interface CreateInvoiceFromOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: WebshopOrder
  onCreated: () => void
}

/** The new customer as typed or prefilled in the dialog. */
interface CustomerDraft {
  name: string
  company: string
  email: string
}

/**
 * The Shopify contact lookup: idle until it runs, `withheld` when the store
 * did not share the customer's name, `unavailable` when it could not answer
 * (extension off, store disconnected, Shopify down).
 */
type ContactLookup = 'idle' | 'loading' | 'ready' | 'withheld' | 'unavailable'

/** The Shopify extension's on-demand answer (GET .../orders/:id/customer). */
interface ShopifyContactAnswer {
  name: string | null
  company: string | null
  email: string | null
  withheld: string[]
}

const EMPTY_DRAFT: CustomerDraft = { name: '', company: '', email: '' }
// Light client check; the route validates the address properly.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * A Shopify order row carries no names by design (crm#1032), so the
 * customer is confirmed here instead of taken from the row.
 */
function needsCustomerInput(order: WebshopOrder): boolean {
  return (
    order.platform === 'shopify' &&
    !order.customer_company &&
    !order.customer_name &&
    !order.customer_email
  )
}

/**
 * Order -> DRAFT kundfaktura (confirm up front, convention 10): the dialog
 * states exactly what will happen, the user confirms, and lands in the draft
 * to review before sending. The customer is matched by e-mail or created from
 * the order's billing snapshot server-side; the scraped orgnr is shown here
 * for the user to eyeball since it never auto-lands on legal invoice fields.
 *
 * For a Shopify order the billing contact is fetched from the store when the
 * dialog opens (core calls the extension route by URL, never by import; with
 * the extension off the fetch simply fails and the fields start empty). The
 * user confirms or edits it, or picks an existing customer; the contact is
 * only ever stored on the customer the invoice is created for.
 */
export default function CreateInvoiceFromOrderDialog({
  open,
  onOpenChange,
  order,
  onCreated,
}: CreateInvoiceFromOrderDialogProps) {
  const t = useTranslations('webshop_orders')
  const locale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()
  const [submitting, setSubmitting] = useState(false)

  const confirmCustomer = needsCustomerInput(order)
  // '' = a new customer from the fields below.
  const [customerId, setCustomerId] = useState('')
  const [draft, setDraft] = useState<CustomerDraft>(EMPTY_DRAFT)
  const [lookup, setLookup] = useState<ContactLookup>('idle')

  useEffect(() => {
    if (!open || !confirmCustomer) return
    let cancelled = false
    setCustomerId('')
    setDraft(EMPTY_DRAFT)
    setLookup('loading')
    fetch(`/api/extensions/ext/shopify/orders/${order.id}/customer`)
      .then(async (res) => (res.ok ? ((await res.json()) as ShopifyContactAnswer) : null))
      .then((answer) => {
        if (cancelled) return
        if (!answer) {
          setLookup('unavailable')
          return
        }
        setDraft({
          name: answer.name ?? '',
          company: answer.company ?? '',
          email: answer.email ?? '',
        })
        setLookup(answer.withheld.includes('name') && !answer.name && !answer.company ? 'withheld' : 'ready')
      })
      .catch(() => {
        if (!cancelled) setLookup('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [open, confirmCustomer, order.id])

  const customerLabel =
    order.customer_company || order.customer_name || t('invoice_no_customer')

  const newCustomer = confirmCustomer && customerId === ''
  const draftMissingName = newCustomer && !draft.name.trim() && !draft.company.trim()
  const draftEmailInvalid = newCustomer && draft.email.trim() !== '' && !EMAIL_RE.test(draft.email.trim())
  const blocked = (newCustomer && lookup === 'loading') || draftMissingName || draftEmailInvalid

  function requestBody(): Record<string, unknown> {
    if (!confirmCustomer) return {}
    if (customerId) return { customer_id: customerId }
    return {
      customer: {
        name: draft.name.trim() || null,
        company: draft.company.trim() || null,
        email: draft.email.trim() || null,
      },
    }
  }

  async function handleCreate() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/webshop-orders/${order.id}/create-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody()),
      })
      const json = (await res.json()) as { invoice_id?: string }
      if (!res.ok || !json.invoice_id) {
        toast({
          title: t('invoice_create_failed'),
          description: getErrorMessage(json, { statusCode: res.status, locale }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('invoice_created') })
      onCreated()
      router.push(`/invoices/${json.invoice_id}`)
    } catch {
      toast({ title: t('invoice_create_failed'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          {/* data-ph-mask: order number and customer name are user data */}
          <DialogTitle data-ph-mask="">{t('invoice_title', { number: order.order_number })}</DialogTitle>
          <DialogDescription data-ph-mask="">
            {confirmCustomer
              ? t('invoice_description_confirm')
              : t('invoice_description', { customer: customerLabel })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {confirmCustomer ? (
            <OrderInvoiceCustomerFields
              customerId={customerId}
              onCustomerIdChange={setCustomerId}
              draft={draft}
              onDraftChange={setDraft}
              lookup={lookup}
              missingName={draftMissingName}
              invalidEmail={draftEmailInvalid}
            />
          ) : (
            <div className="space-y-1">
              <div>{customerLabel}</div>
              {order.customer_email && (
                <div className="text-muted-foreground">{order.customer_email}</div>
              )}
              {order.customer_orgnr && (
                <div className="text-muted-foreground">
                  {t('invoice_orgnr_hint', { orgnr: order.customer_orgnr })}
                </div>
              )}
            </div>
          )}

          {order.line_items.length > 0 && (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={VTH_CLASS}>{t('invoice_col_item')}</th>
                  <th className={cn(VTH_CLASS, 'text-right')}>{t('invoice_col_amount')}</th>
                </tr>
              </thead>
              <tbody>
                {order.line_items.map((item, index) => (
                  <tr key={index}>
                    <td className={VTD_CLASS}>
                      {item.quantity} × {item.name}
                    </td>
                    <td className={cn(VTD_CLASS, 'text-right tabular-nums')}>
                      {formatCurrency(item.total + item.total_tax, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex justify-between text-[13px]">
            <span className="text-muted-foreground">{t('invoice_total')}</span>
            <span className="tabular-nums">{formatCurrency(order.total, order.currency)}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={submitting || blocked}>
            {submitting ? t('invoice_creating') : t('invoice_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface OrderInvoiceCustomerFieldsProps {
  customerId: string
  onCustomerIdChange: (id: string) => void
  draft: CustomerDraft
  onDraftChange: (draft: CustomerDraft) => void
  lookup: ContactLookup
  missingName: boolean
  invalidEmail: boolean
}

/**
 * Pick an existing customer, or confirm the new one prefilled from the
 * store. Its own component so only these orders load the customer register.
 */
function OrderInvoiceCustomerFields({
  customerId,
  onCustomerIdChange,
  draft,
  onDraftChange,
  lookup,
  missingName,
  invalidEmail,
}: OrderInvoiceCustomerFieldsProps) {
  const t = useTranslations('webshop_orders')
  const { customers, isLoading } = useCustomers()
  const fetching = lookup === 'loading'
  // The withheld line already asks for the customer; no second hint then.
  const showRequired = missingName && !fetching && lookup !== 'withheld'
  const set = (field: keyof CustomerDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onDraftChange({ ...draft, [field]: e.target.value })

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="order-invoice-customer" className="text-xs">
          {t('invoice_customer_label')}
        </Label>
        <CustomerCombobox
          id="order-invoice-customer"
          value={customerId}
          customers={customers}
          onChange={onCustomerIdChange}
          loading={isLoading}
          placeholder={t('invoice_customer_search')}
          noneLabel={t('invoice_customer_new')}
        />
      </div>

      {customerId === '' && (
        <div className="space-y-3">
          {fetching && (
            <p className="text-[12.5px] text-muted-foreground">{t('invoice_customer_fetching')}</p>
          )}
          {lookup === 'withheld' && (
            <p className="attn text-[12.5px]">{t('invoice_customer_withheld')}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="order-invoice-customer-name" className="text-xs">
                {t('invoice_customer_name')}
              </Label>
              <Input
                id="order-invoice-customer-name"
                data-ph-mask=""
                autoComplete="off"
                value={draft.name}
                onChange={set('name')}
                disabled={fetching}
                aria-describedby={showRequired ? 'order-invoice-customer-name-hint' : undefined}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label htmlFor="order-invoice-customer-company" className="text-xs">
                {t('invoice_customer_company')}
              </Label>
              <Input
                id="order-invoice-customer-company"
                data-ph-mask=""
                autoComplete="off"
                value={draft.company}
                onChange={set('company')}
                disabled={fetching}
              />
            </div>
          </div>
          {showRequired && (
            <p id="order-invoice-customer-name-hint" className="text-xs text-muted-foreground">
              {t('invoice_customer_required')}
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor="order-invoice-customer-email" className="text-xs">
              {t('invoice_customer_email')}
            </Label>
            <Input
              id="order-invoice-customer-email"
              type="email"
              data-ph-mask=""
              autoComplete="off"
              value={draft.email}
              onChange={set('email')}
              disabled={fetching}
              aria-invalid={invalidEmail}
              aria-describedby={invalidEmail ? 'order-invoice-customer-email-error' : undefined}
            />
            {invalidEmail && (
              <p id="order-invoice-customer-email-error" className="text-xs text-destructive" role="alert">
                {t('invoice_customer_email_invalid')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
