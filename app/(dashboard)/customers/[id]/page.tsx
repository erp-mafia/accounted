'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { use } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DetailSection, DefRow, DefEmpty } from '@/components/ui/detail-section'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
  maskCustomerPersonalNumber,
} from '@/lib/customers/mask-personal-number'
import { AttnLine } from '@/components/ui/attn-line'
import CustomerForm from '@/components/customers/CustomerForm'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { ArrowLeft, Loader2, Lock, Eye, EyeOff } from 'lucide-react'
import { useLocale } from 'next-intl'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatDate } from '@/lib/utils'
import { invoiceNumberDisplay } from '@/lib/invoices/display'
import { getCountryName } from '@/lib/vat/country-codes'
import type { Customer, CustomerType, CreateCustomerInput } from '@/types'
import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'
import { PartyFactsSection } from '@/components/parties/PartyFactsSection'
import { usePartyDossier } from '@/components/parties/use-party-dossier'
import { fromRegistry, addressRowsFromRegistry, listSv } from '@/lib/parties/registry-summary'

const CUSTOMER_TYPE_KEY: Record<CustomerType, string> = {
  individual: 'type_individual',
  swedish_business: 'type_swedish_business',
  eu_business: 'type_eu_business',
  non_eu_business: 'type_non_eu_business',
}

interface RelatedInvoice {
  id: string
  invoice_number: string | null
  invoice_date: string
  due_date: string
  status: string
  total: number
  currency: string
  payment_status: string
}

interface CustomerWithRelations extends Customer {
  invoices: RelatedInvoice[]
}

export default function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const t = useTranslations('customer_detail')
  const tParties = useTranslations('parties')
  const errorLocale = useLocale() as ErrorLocale
  const [customer, setCustomer] = useState<CustomerWithRelations | null>(null)
  const partyId = customer && customer.customer_type !== 'individual' ? ((customer as { party_id?: string | null }).party_id ?? null) : null
  const party = usePartyDossier(partyId)
  const registryAddress = party.registry?.contact.address ? addressRowsFromRegistry(party.registry.contact.address) : null
  // Which contact fields carry what the register said: one note for the
  // section, not a tag under every row.
  const registryFields = [
    fromRegistry(customer.email, party.registry?.contact.email) ? tParties('fact_email') : null,
    fromRegistry(customer.phone, party.registry?.contact.phone) ? tParties('fact_phone') : null,
    !!registryAddress && fromRegistry(customer.address_line1, registryAddress.address_line1) && fromRegistry(customer.city, registryAddress.city) ? tParties('facts_address_short') : null,
    fromRegistry(customer.vat_number, party.registry?.vat_number) ? tParties('fact_vat') : null,
  ].filter((x): x is string => !!x)
  const registryNote = registryFields.length ? (
    <p className="pt-2 text-xs text-muted-foreground">{tParties('facts_contact_from_registry', { fields: listSv(registryFields, tParties('facts_list_and')) })}</p>
  ) : null
  const [isLoading, setIsLoading] = useState(true)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  // Full personnummer, fetched on demand and held only for this view. Cleared
  // whenever the customer is refetched so it can never outlive the row it
  // belongs to.
  const [revealedPersonalNumber, setRevealedPersonalNumber] = useState<string | null>(null)
  const [isRevealing, setIsRevealing] = useState(false)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  const isUnreadablePersonalNumber =
    customer?.personal_number === UNDECRYPTABLE_PERSONAL_NUMBER_MASK

  async function togglePersonalNumber() {
    if (revealedPersonalNumber) {
      setRevealedPersonalNumber(null)
      return
    }
    setIsRevealing(true)
    try {
      const response = await fetch(`/api/customers/${id}/personal-number`)
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: t('personal_number_reveal_failed_title'),
          description: getErrorMessage(result, { context: 'customer', locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      setRevealedPersonalNumber(result.data.personal_number)
    } catch {
      toast({
        title: t('personal_number_reveal_failed_title'),
        description: t('retry'),
        variant: 'destructive',
      })
    } finally {
      setIsRevealing(false)
    }
  }

  useEffect(() => {
    fetchCustomer()
  }, [id])

  async function fetchCustomer() {
    setIsLoading(true)
    setRevealedPersonalNumber(null)
    try {
      const response = await fetch(`/api/customers/${id}`)
      if (!response.ok) {
        throw new Error('Not found')
      }
      const { data } = await response.json()
      setCustomer(data)
    } catch {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      router.push('/customers')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleUpdate(data: CreateCustomerInput) {
    setIsUpdating(true)
    try {
      const response = await fetch(`/api/customers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        throw new Error('Update failed')
      }

      toast({
        title: t('updated_title'),
        description: data.name,
      })
      setIsEditOpen(false)
      fetchCustomer()
    } catch {
      toast({
        title: t('update_failed_title'),
        description: t('retry'),
        variant: 'destructive',
      })
    } finally {
      setIsUpdating(false)
    }
  }

  async function handleDelete() {
    if (!customer) return
    const ok = await confirmAction({
      title: t('delete_confirm_title', { name: customer.name }),
      description: t('delete_confirm_description'),
      confirmLabel: t('delete_confirm_label'),
      variant: 'destructive',
    })
    if (!ok) return

    try {
      const response = await fetch(`/api/customers/${id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('Delete failed')
      }

      toast({
        title: t('deleted_title'),
        description: customer.name,
      })
      router.push('/customers')
    } catch {
      toast({
        title: t('delete_failed_title'),
        description: t('retry'),
        variant: 'destructive',
      })
    }
  }

  const formatCurrency = (amount: number | null, currency: string | null) => {
    if (!amount) return '-'
    return new Intl.NumberFormat('sv-SE', {
      style: 'currency',
      currency: currency || 'SEK',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  if (isLoading) {
    return <DetailPageSkeleton />
  }

  if (!customer) return null

  return (
    <div className="max-w-2xl space-y-8 stagger-enter">
      {/* Header: serif name over a quiet type kicker, quiet actions right */}
      <div>
        <Link
          href="/customers"
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-display text-2xl leading-8 tracking-tight">{customer.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(CUSTOMER_TYPE_KEY[customer.customer_type])}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsEditOpen(true)}
              className="min-h-10 text-muted-foreground hover:text-foreground"
              disabled={!canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {!canWrite && <Lock className="h-4 w-4 mr-1" />}
              {t('edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              className="min-h-10 text-muted-foreground hover:text-destructive"
              disabled={!canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {!canWrite && <Lock className="h-4 w-4 mr-1" />}
              {t('delete')}
            </Button>
          </div>
        </div>
      </div>

      <DetailSection kicker={t('section_contact')}>
        <DefRow label={t('def_email')}>
          {customer.email ? (
            <a href={`mailto:${customer.email}`} className="hover:underline">
              {customer.email}
            </a>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        <DefRow label={t('def_phone')}>
          {customer.phone || <DefEmpty />}
        </DefRow>
        <DefRow label={t('def_address')}>
          {customer.address_line1 || customer.city ? (
            <div>
              {customer.address_line1 && <p>{customer.address_line1}</p>}
              {customer.address_line2 && <p>{customer.address_line2}</p>}
              {(customer.postal_code || customer.city) && (
                <p>{[customer.postal_code, customer.city].filter(Boolean).join(' ')}</p>
              )}
              {customer.country && <p>{getCountryName(customer.country, errorLocale)}</p>}
            </div>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        {registryNote}
      </DetailSection>

      {partyId && party.dossier ? (
        <PartyFactsSection
          partyId={partyId}
          rowName={customer.name}
          canWrite={canWrite}
          dossier={party.dossier}
          registry={party.registry}
          scbEnabled={party.scbEnabled}
          onChanged={async () => {
            await party.reload()
            await fetchCustomer()
          }}
        />
      ) : null}

      <DetailSection kicker={t('section_business')}>
        <DefRow label={t('def_customer_number')}>
          {customer.customer_number || <DefEmpty />}
        </DefRow>
        {customer.customer_type !== 'individual' && (
          <DefRow label={t('def_org_number')}>
            {customer.org_number ? (
              <span className="tabular-nums">{customer.org_number}</span>
            ) : (
              <DefEmpty />
            )}
          </DefRow>
        )}
        {customer.customer_type === 'individual' && (customer.personal_number || customer.org_number) && (
          <DefRow label={t('def_personal_number')}>
            <span className="tabular-nums">
              {revealedPersonalNumber ??
                maskCustomerPersonalNumber(customer.personal_number || customer.org_number)}
            </span>
            {/* Viewers keep the mask: the endpoint refuses them anyway. */}
            {canWrite && customer.personal_number && !isUnreadablePersonalNumber && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-1 h-10 w-10 -my-2 align-middle"
                onClick={togglePersonalNumber}
                disabled={isRevealing}
                aria-label={revealedPersonalNumber ? t('personal_number_hide') : t('personal_number_show')}
                title={revealedPersonalNumber ? t('personal_number_hide') : t('personal_number_show')}
              >
                {isRevealing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : revealedPersonalNumber ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            )}
            {isUnreadablePersonalNumber && (
              <AttnLine
                className="mt-1"
                action={{ label: t('personal_number_unreadable_action'), onClick: () => setIsEditOpen(true) }}
              >
                {t('personal_number_unreadable')}
              </AttnLine>
            )}
          </DefRow>
        )}
        {customer.vat_number && (
          <DefRow label={t('def_vat')}>
            <span className="inline-flex flex-wrap items-center gap-2">
              {customer.vat_number}
              {customer.vat_number_validated && (
                <Badge variant="success" className="text-xs">{t('verified')}</Badge>
              )}
            </span>
          </DefRow>
        )}
        <DefRow label={t('def_payment_terms')}>
          {t('payment_terms_value', { days: customer.default_payment_terms || 30 })}
        </DefRow>
      </DetailSection>

      {customer.notes && (
        <DetailSection kicker={t('section_notes')}>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{customer.notes}</p>
        </DetailSection>
      )}

      <DetailSection
        kicker={t('section_invoices')}
        aside={
          customer.invoices?.length > 0 ? (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {t('invoice_count', { count: customer.invoices.length })}
            </span>
          ) : undefined
        }
      >
        {customer.invoices?.length > 0 ? (
          <div className="divide-y divide-border">
            {customer.invoices.map((invoice) => (
              <Link
                key={invoice.id}
                href={`/invoices/${invoice.id}`}
                className="flex items-center gap-3 py-3 text-sm transition-colors duration-150 hover:bg-secondary/35"
              >
                <span
                  className={cn(
                    'min-w-0 truncate',
                    !invoice.invoice_number && 'italic text-muted-foreground',
                  )}
                >
                  {invoiceNumberDisplay(invoice.invoice_number)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {formatDate(invoice.invoice_date)}
                </span>
                <span className="ml-auto tabular-nums">
                  {formatCurrency(invoice.total, invoice.currency)}
                </span>
                {/* Chips mark exceptions: an overdue invoice is the deviation
                    worth a chip; paid and not-yet-due render as muted text. */}
                {invoice.payment_status === 'overdue' ? (
                  <Badge variant="destructive">{t('invoice_status_overdue')}</Badge>
                ) : (
                  <span className="min-w-14 text-right text-xs text-muted-foreground">
                    {invoice.payment_status === 'paid'
                      ? t('invoice_status_paid')
                      : t('invoice_status_unpaid')}
                  </span>
                )}
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('no_invoices')}</p>
        )}
      </DetailSection>

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {/* Edit dialog */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('edit_dialog_title')}</DialogTitle>
          </DialogHeader>
          <CustomerForm
            onSubmit={handleUpdate}
            isLoading={isUpdating}
            initialData={{
              name: customer.name,
              customer_type: customer.customer_type,
              customer_number: customer.customer_number || undefined,
              email: customer.email || undefined,
              phone: customer.phone || undefined,
              address_line1: customer.address_line1 || undefined,
              address_line2: customer.address_line2 || undefined,
              postal_code: customer.postal_code || undefined,
              city: customer.city || undefined,
              country: customer.country || undefined,
              org_number: customer.org_number || undefined,
              vat_number: customer.vat_number || undefined,
              personal_number: customer.personal_number || undefined,
              // Must round-trip: the form defaults omitted values ('sv') and
              // submits every field, so leaving language out resets it on save.
              language: customer.language,
              default_payment_terms: customer.default_payment_terms || undefined,
              notes: customer.notes || undefined,
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
