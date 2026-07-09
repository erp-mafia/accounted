'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DataList,
  DataListRow,
  DataListPrimary,
  DataListMeta,
  DataListMetaSeparator,
  DataListEmpty,
} from '@/components/ui/data-list'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { invoiceDisplayNumber } from '@/lib/invoices/display'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { Plus, Search, ReceiptText, Lock, Repeat } from 'lucide-react'
import { EmptyInvoices } from '@/components/ui/empty-state'
import NewInvoiceDialog from '@/components/invoices/NewInvoiceDialog'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Invoice, InvoiceStatus } from '@/types'

type InvoiceStatusVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive'

const STATUS_CONFIG: Record<InvoiceStatus, { labelKey: string; variant: InvoiceStatusVariant }> = {
  draft: { labelKey: 'status_draft', variant: 'secondary' },
  sent: { labelKey: 'status_sent', variant: 'default' },
  paid: { labelKey: 'status_paid', variant: 'success' },
  partially_paid: { labelKey: 'status_partially_paid', variant: 'warning' },
  overdue: { labelKey: 'status_overdue', variant: 'destructive' },
  cancelled: { labelKey: 'status_cancelled', variant: 'secondary' },
  credited: { labelKey: 'status_credited', variant: 'secondary' },
}

function useRelativeTimeLabel() {
  const t = useTranslations('invoices')
  return function getRelativeTimeLabel(dueDateStr: string, status: InvoiceStatus): { text: string; color: string } | null {
    if (status === 'paid' || status === 'cancelled' || status === 'credited' || status === 'draft') return null

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dueDate = new Date(dueDateStr)
    dueDate.setHours(0, 0, 0, 0)
    const diffDays = Math.round((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

    if (diffDays < 0) {
      return { text: t('due_days_overdue', { days: Math.abs(diffDays) }), color: 'text-destructive' }
    } else if (diffDays === 0) {
      return { text: t('due_today'), color: 'text-warning-foreground' }
    } else if (diffDays <= 3) {
      return { text: t('due_days_left', { days: diffDays }), color: 'text-warning-foreground' }
    } else if (diffDays <= 7) {
      return { text: t('due_days_left', { days: diffDays }), color: 'text-muted-foreground' }
    }
    return null
  }
}

export default function InvoicesPage() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [oreRounding, setOreRounding] = useState<boolean>(true)
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('invoices')
  const getRelativeTimeLabel = useRelativeTimeLabel()

  // The "Ny faktura" modal is driven by the URL (?new=1) so every entry point
  // (the header button, empty states, the command palette, and the legacy
  // /invoices/new redirect) opens the same dialog, and the browser back
  // button closes it. No canWrite gate here: like the old /invoices/new page,
  // the editor itself disables submission for viewers.
  const showNewInvoice = searchParams.has('new')
  const closeNewInvoice = () => router.replace('/invoices', { scroll: false })
  const openNewInvoice = () => router.push('/invoices?new=1', { scroll: false })

  async function fetchInvoices() {
    if (!company) return
    setIsLoading(true)
    const [invoicesResult, settingsResult] = await Promise.all([
      supabase
        .from('invoices')
        .select('*, customer:customers(name)')
        .eq('company_id', company.id)
        .order('invoice_date', { ascending: false }),
      supabase
        .from('company_settings')
        .select('ore_rounding')
        .eq('company_id', company.id)
        .maybeSingle(),
    ])

    if (invoicesResult.error) {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
    } else {
      setInvoices(invoicesResult.data || [])
    }
    setOreRounding(settingsResult.data?.ore_rounding ?? true)
    setIsLoading(false)
  }

  useEffect(() => {
    fetchInvoices()
  }, [])

  const filteredInvoices = invoices.filter((invoice) => {
    const matchesSearch =
      (invoice.invoice_number ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (invoice.external_invoice_number ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (invoice.customer as { name: string })?.name?.toLowerCase().includes(searchTerm.toLowerCase())

    const isCreditNote = !!invoice.credited_invoice_id
    const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
    const matchesTab =
      (activeTab === 'all' && invoice.status !== 'cancelled') ||
      (activeTab === 'unpaid' && ['sent', 'overdue'].includes(invoice.status) && !isCreditNote && docType === 'invoice') ||
      (activeTab === 'credit' && isCreditNote) ||
      (activeTab === 'proforma' && docType === 'proforma' && invoice.status !== 'cancelled') ||
      (activeTab === 'delivery_note' && docType === 'delivery_note' && invoice.status !== 'cancelled') ||
      (activeTab === 'cancelled' && invoice.status === 'cancelled') ||
      (activeTab !== 'all' && activeTab !== 'proforma' && activeTab !== 'delivery_note' && activeTab !== 'cancelled' && invoice.status === activeTab)

    return matchesSearch && matchesTab
  })

  const isOutstandingReceivable = (i: Invoice) =>
    ['sent', 'overdue'].includes(i.status) && !i.credited_invoice_id
  const stats = {
    unpaid: invoices.filter(isOutstandingReceivable).length,
    unpaidAmount: invoices
      .filter(isOutstandingReceivable)
      .reduce((sum, i) => {
        if (i.currency === 'SEK') {
          return sum + getDisplayTotal({ total: Number(i.total), currency: 'SEK', ore_rounding: i.ore_rounding }, { ore_rounding: oreRounding }).displayed
        }
        return sum + Number(i.total_sek || i.total)
      }, 0),
    overdue: invoices.filter((i) => i.status === 'overdue' && !i.credited_invoice_id).length,
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          <div className="flex gap-2">
            <Link href="/invoices/recurring">
              <Button variant="secondary">
                <Repeat className="mr-2 h-4 w-4" />
                {t('recurring')}
              </Button>
            </Link>
            {canWrite ? (
              <Button onClick={openNewInvoice}>
                <Plus className="mr-2 h-4 w-4" />
                {t('new_invoice')}
              </Button>
            ) : (
              <Button
                disabled
                title={t('viewer_disabled_tooltip')}
              >
                <Lock className="mr-2 h-4 w-4" />
                {t('new_invoice')}
              </Button>
            )}
          </div>
        }
      />

      {/* Inline summary */}
      {!isLoading && invoices.length > 0 && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {invoices.length === 1 ? t('summary_one', { count: invoices.length }) : t('summary_other', { count: invoices.length })}
          {stats.unpaid > 0 && (
            <>
              {' · '}
              <span className="text-foreground">{t('summary_unpaid', { count: stats.unpaid })}</span>
              {' · '}
              {t('summary_to_collect', { amount: formatCurrency(stats.unpaidAmount) })}
              {stats.overdue > 0 && (
                <>
                  {' · '}
                  <span className="text-destructive">{t('summary_overdue', { count: stats.overdue })}</span>
                </>
              )}
            </>
          )}
        </p>
      )}

      {/* Search and tabs */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('search_placeholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="min-w-0">
          <TabsList className="w-max max-w-full justify-start">
            <TabsTrigger value="all">{t('tab_all')}</TabsTrigger>
            <TabsTrigger value="unpaid">{t('tab_unpaid')}</TabsTrigger>
            <TabsTrigger value="paid">{t('tab_paid')}</TabsTrigger>
            <TabsTrigger value="draft">{t('tab_draft')}</TabsTrigger>
            <TabsTrigger value="proforma">{t('tab_proforma')}</TabsTrigger>
            <TabsTrigger value="delivery_note">{t('tab_delivery_note')}</TabsTrigger>
            <TabsTrigger value="credit">{t('tab_credit')}</TabsTrigger>
            <TabsTrigger value="cancelled">{t('tab_cancelled')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <DataList>
        {isLoading ? (
          [1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-5 w-24" />
            </div>
          ))
        ) : filteredInvoices.length === 0 ? (
          searchTerm ? (
            <DataListEmpty
              icon={<ReceiptText className="h-6 w-6" />}
              title={t('no_search_results_title')}
              description={t('no_search_results_description', { term: searchTerm })}
            />
          ) : invoices.length === 0 ? (
            <EmptyInvoices onAction={openNewInvoice} />
          ) : (
            <DataListEmpty
              icon={<ReceiptText className="h-6 w-6" />}
              title={t('no_category_title')}
              description={t('no_category_description')}
            />
          )
        ) : (
          filteredInvoices.map((invoice) => {
            const status = STATUS_CONFIG[invoice.status]
            const isCreditNote = !!invoice.credited_invoice_id
            const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
            const isProforma = docType === 'proforma'
            const isDeliveryNote = docType === 'delivery_note'
            // A draft that already has a number is issued-but-unsent ("Granska &
            // skapa" done, "Skicka" pending): distinct from a true unnumbered
            // draft. Show "Ej skickad" so the two don't look alike. Display-only.
            const isUnsentInvoice =
              invoice.status === 'draft' &&
              !!invoice.invoice_number &&
              !isProforma &&
              !isDeliveryNote &&
              !isCreditNote &&
              !invoice.is_self_billed
            const statusLabelKey = isUnsentInvoice ? 'status_unsent' : status.labelKey
            const statusVariant: InvoiceStatusVariant | 'outline' = isUnsentInvoice ? 'outline' : status.variant
            const relativeTime = invoice.due_date ? getRelativeTimeLabel(invoice.due_date, invoice.status) : null
            const displayedTotal = getDisplayTotal(
              { total: Number(invoice.total), currency: invoice.currency, ore_rounding: invoice.ore_rounding },
              { ore_rounding: oreRounding },
            ).displayed
            return (
              <Link key={invoice.id} href={`/invoices/${invoice.id}`} className="block focus:outline-none">
                <DataListRow
                  trailing={
                    <div className="text-right">
                      <p
                        className={cn(
                          'font-medium tabular-nums leading-none',
                          isCreditNote && 'text-destructive'
                        )}
                      >
                        {formatCurrency(displayedTotal, invoice.currency)}
                      </p>
                      {invoice.currency !== 'SEK' && invoice.total_sek && (
                        <p
                          className={cn(
                            'mt-1 text-[11px] tabular-nums',
                            isCreditNote ? 'text-destructive/70' : 'text-muted-foreground'
                          )}
                        >
                          {formatCurrency(Number(invoice.total_sek))}
                        </p>
                      )}
                    </div>
                  }
                >
                  <DataListPrimary className={cn(!invoice.invoice_number && !invoice.external_invoice_number && 'italic text-muted-foreground')}>
                    {invoice.is_self_billed ? invoiceDisplayNumber(invoice) : (invoice.invoice_number ?? '-')}{' '}
                    <span className="font-normal text-muted-foreground">
                      · {(invoice.customer as { name: string })?.name}
                    </span>
                  </DataListPrimary>
                  <DataListMeta>
                    <span className="tabular-nums">{formatDate(invoice.invoice_date)}</span>
                    <DataListMetaSeparator />
                    <Badge
                      variant={statusVariant as 'default' | 'secondary' | 'destructive' | 'outline'}
                      className="h-4 px-1.5 py-0 text-[10px]"
                    >
                      {t(statusLabelKey)}
                    </Badge>
                    {isCreditNote && (
                      <>
                        <DataListMetaSeparator />
                        <Badge variant="destructive" className="h-4 px-1.5 py-0 text-[10px]">
                          {t('badge_credit')}
                        </Badge>
                      </>
                    )}
                    {isProforma && (
                      <>
                        <DataListMetaSeparator />
                        <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px]">
                          {t('badge_proforma')}
                        </Badge>
                      </>
                    )}
                    {isDeliveryNote && (
                      <>
                        <DataListMetaSeparator />
                        <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px]">
                          {t('badge_delivery_note')}
                        </Badge>
                      </>
                    )}
                    {invoice.is_self_billed && (
                      <>
                        <DataListMetaSeparator />
                        <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px]">
                          {t('badge_self_billed')}
                        </Badge>
                      </>
                    )}
                    {relativeTime && (
                      <>
                        <DataListMetaSeparator />
                        <span className={cn('font-medium', relativeTime.color)}>
                          {relativeTime.text}
                        </span>
                      </>
                    )}
                  </DataListMeta>
                </DataListRow>
              </Link>
            )
          })
        )}
      </DataList>

      <NewInvoiceDialog
        open={showNewInvoice}
        onOpenChange={(open) => {
          if (!open) closeNewInvoice()
        }}
      />
    </div>
  )
}
