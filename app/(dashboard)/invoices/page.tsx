'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { DataListEmpty } from '@/components/ui/data-list'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { FyPicker } from '@/components/common/FyPicker'
import { ContextPicker } from '@/components/common/ContextPicker'
import { SplitButton, type SplitButtonOption } from '@/components/ui/split-button'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { resolveInitialMode } from '@/lib/ui-state/client'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { invoiceDisplayNumber } from '@/lib/invoices/display'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { Plus, Search, ReceiptText, Repeat, FileInput, FileDown } from 'lucide-react'
import { EmptyInvoices } from '@/components/ui/empty-state'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { FiscalPeriod, Invoice, InvoiceStatus } from '@/types'

function NewInvoiceDialogLoading() {
  const t = useTranslations('invoices')
  return (
    <Dialog open>
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle>{t('new_invoice')}</DialogTitle>
        <div className="space-y-4 py-4" role="status">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-40" />
        </div>
      </DialogContent>
    </Dialog>
  )
}

const NewInvoiceDialog = dynamic(
  () => import('@/components/invoices/NewInvoiceDialog'),
  { loading: NewInvoiceDialogLoading },
)

const RotRutPayoutDialog = dynamic(
  () => import('@/components/invoices/RotRutPayoutDialog'),
)

const INITIAL_VISIBLE_ROWS = 100

const CREATE_MODES = ['faktura', 'aterkommande', 'sjalvfaktura'] as const

// Main views (concept seg) and the low-frequency views behind "Fler …".
const SEG_TABS = ['all', 'unpaid', 'overdue', 'draft'] as const
const MORE_TABS = ['paid', 'proforma', 'delivery_note', 'credit', 'cancelled'] as const
type ListTab = (typeof SEG_TABS)[number] | (typeof MORE_TABS)[number]

const TAB_LABEL_KEYS: Record<ListTab, string> = {
  all: 'tab_all',
  unpaid: 'tab_unpaid',
  overdue: 'tab_overdue',
  draft: 'tab_draft',
  paid: 'tab_paid',
  proforma: 'tab_proforma',
  delivery_note: 'tab_delivery_note',
  credit: 'tab_credit',
  cancelled: 'tab_cancelled',
}

function daysOverdue(dueDateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dueDate = new Date(dueDateStr)
  dueDate.setHours(0, 0, 0, 0)
  return Math.round((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
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
  const [activeTab, setActiveTab] = useState<ListTab>(() => {
    // Deep links from the worklist and older bookmarks: ?status= / ?tab=.
    const param = searchParams.get('status') ?? searchParams.get('tab')
    const alias: Record<string, ListTab> = { drafts: 'draft' }
    const candidate = param ? (alias[param] ?? (param as ListTab)) : null
    return candidate && [...SEG_TABS, ...MORE_TABS].includes(candidate as never)
      ? (candidate as ListTab)
      : 'all'
  })
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ROWS)
  // Fiscal-year scope (convention 8): null = all years.
  const [fyPeriodId, setFyPeriodId] = useState<string | null>(null)
  const [fyPeriod, setFyPeriod] = useState<FiscalPeriod | null>(null)
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('invoices')
  const tCommon = useTranslations('common')
  const { uiState, loaded: uiStateLoaded } = useUiState()

  // The "Ny faktura" modal is driven by the URL (?new=1) so every entry point
  // (the header button, empty states, the command palette, and the legacy
  // /invoices/new redirect) opens the same dialog, and the browser back
  // button closes it. No canWrite gate here: like the old /invoices/new page,
  // the editor itself disables submission for viewers. ?self=1 preselects the
  // självfaktura tab (split-button entry).
  const copyFromId = searchParams.get('copy')
  const showNewInvoice = searchParams.has('new') || copyFromId !== null
  const openSelfBilled = searchParams.has('self')
  const showRotRutPayout = searchParams.has('rot-rut')
  const closeNewInvoice = () => router.replace('/invoices', { scroll: false })
  const openNewInvoice = () => router.push('/invoices?new=1', { scroll: false })
  const openNewSelfBilled = () => router.push('/invoices?new=1&self=1', { scroll: false })
  const closeRotRutPayout = () => router.replace('/invoices', { scroll: false })
  const openRotRutPayout = () => router.push('/invoices?rot-rut=1', { scroll: false })

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filteredInvoices = invoices.filter((invoice) => {
    const matchesSearch =
      (invoice.invoice_number ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (invoice.external_invoice_number ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (invoice.customer as { name: string })?.name?.toLowerCase().includes(searchTerm.toLowerCase())

    const matchesFy =
      !fyPeriod ||
      (invoice.invoice_date >= fyPeriod.period_start && invoice.invoice_date <= fyPeriod.period_end)

    const isCreditNote = !!invoice.credited_invoice_id
    const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
    const matchesTab =
      (activeTab === 'all' && invoice.status !== 'cancelled') ||
      (activeTab === 'unpaid' && ['sent', 'overdue'].includes(invoice.status) && !isCreditNote && docType === 'invoice') ||
      (activeTab === 'overdue' && invoice.status === 'overdue' && !isCreditNote && docType === 'invoice') ||
      (activeTab === 'draft' && invoice.status === 'draft' && docType === 'invoice' && !isCreditNote) ||
      (activeTab === 'paid' && invoice.status === 'paid') ||
      (activeTab === 'credit' && isCreditNote) ||
      (activeTab === 'proforma' && docType === 'proforma' && invoice.status !== 'cancelled') ||
      (activeTab === 'delivery_note' && docType === 'delivery_note' && invoice.status !== 'cancelled') ||
      (activeTab === 'cancelled' && invoice.status === 'cancelled')

    return matchesSearch && matchesFy && matchesTab
  })
  const visibleInvoices = filteredInvoices.slice(0, visibleCount)

  const overdueCount = invoices.filter(
    (i) => i.status === 'overdue' && !i.credited_invoice_id,
  ).length

  const resetPaging = () => setVisibleCount(INITIAL_VISIBLE_ROWS)

  const createOptions: SplitButtonOption[] = [
    {
      key: 'faktura',
      label: t('new_invoice'),
      icon: Plus,
      description: t('create_invoice_desc'),
      disabled: !canWrite,
      disabledTitle: t('viewer_disabled_tooltip'),
      onSelect: () => openNewInvoice(),
    },
    {
      key: 'aterkommande',
      label: t('create_recurring'),
      icon: Repeat,
      description: t('create_recurring_desc'),
      onSelect: () => router.push('/invoices/recurring'),
    },
    {
      key: 'sjalvfaktura',
      label: t('create_self'),
      icon: FileInput,
      description: t('create_self_desc'),
      disabled: !canWrite,
      disabledTitle: t('viewer_disabled_tooltip'),
      onSelect: () => openNewSelfBilled(),
    },
  ]

  // One derivable status chip per row (concept scene 15). Doc-type markers
  // (proforma/följesedel/självfaktura) only appear in views where the type
  // isn't already implied.
  function statusChip(invoice: Invoice): { label: string; variant: 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' } {
    const isCreditNote = !!invoice.credited_invoice_id
    if (invoice.status === 'cancelled') return { label: t('status_cancelled'), variant: 'secondary' }
    if (isCreditNote && invoice.status !== 'paid') return { label: t('badge_credit'), variant: 'destructive' }
    if (invoice.status === 'credited') return { label: t('status_credited'), variant: 'secondary' }
    if (invoice.status === 'draft') {
      const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
      const isUnsent =
        !!invoice.invoice_number && docType === 'invoice' && !isCreditNote && !invoice.is_self_billed
      return isUnsent
        ? { label: t('status_unsent'), variant: 'outline' }
        : { label: t('status_draft'), variant: 'secondary' }
    }
    if (invoice.status === 'paid') {
      return {
        label: invoice.paid_at
          ? t('status_paid_date', { date: formatDate(invoice.paid_at) })
          : t('status_paid'),
        variant: 'success',
      }
    }
    if (invoice.status === 'partially_paid') return { label: t('status_partially_paid'), variant: 'warning' }
    if (invoice.status === 'overdue' && invoice.due_date) {
      return {
        label: t('status_overdue_days', { days: Math.max(1, daysOverdue(invoice.due_date)) }),
        variant: 'warning',
      }
    }
    return { label: t('status_sent'), variant: 'outline' }
  }

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 15): title + invoice actions */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={openRotRutPayout}
            disabled={!canWrite}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
          >
            <FileDown className="mr-2 h-4 w-4" />
            {t('rot_rut_payout_action')}
          </Button>
          <SplitButton
            key={uiStateLoaded ? 'loaded' : 'initial'}
            persistKey="invoices"
            initialModeKey={resolveInitialMode(uiState, 'invoices', CREATE_MODES, 'faktura')}
            options={createOptions}
          />
        </div>
      </div>

      {/* Toolbar: one status chip-picker (founder direction: the status
          views live behind a filter chip, not a seg), sök, FyPicker far
          right. Counts ride as row annotations and on the trigger. */}
      <div className="flex flex-wrap items-center gap-2">
        <ContextPicker
          value={activeTab}
          onChange={(id) => {
            setActiveTab(id as ListTab)
            resetPaging()
          }}
          ariaLabel={t('status_picker_aria')}
          triggerLabel={
            activeTab === 'overdue' && overdueCount > 0
              ? `${t(TAB_LABEL_KEYS[activeTab])} · ${overdueCount}`
              : t(TAB_LABEL_KEYS[activeTab])
          }
          items={[...SEG_TABS, ...MORE_TABS].map((tab) => ({
            id: tab,
            label: t(TAB_LABEL_KEYS[tab]),
            annotation:
              tab === 'overdue' && overdueCount > 0 ? String(overdueCount) : undefined,
          }))}
        />
        <div className="relative min-w-[190px] max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('search_placeholder')}
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value)
              resetPaging()
            }}
            className="h-9 pl-10"
          />
        </div>
        <div className="ml-auto">
          <FyPicker
            value={fyPeriodId}
            onChange={(periodId, period) => {
              setFyPeriodId(periodId)
              setFyPeriod(period ?? null)
              resetPaging()
            }}
            includeAllOption
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-48 flex-1" />
              <Skeleton className="h-5 w-24" />
            </div>
          ))}
        </div>
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
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('th_nr')}</th>
                <th className={cn(TH_CLASS, 'w-full')}>{t('th_customer')}</th>
                <th className={cn(TH_CLASS, 'hidden text-right sm:table-cell')}>{t('th_due')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_amount')}</th>
                <th className={TH_CLASS}>{t('th_status')}</th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {visibleInvoices.map((invoice) => {
                const chip = statusChip(invoice)
                const isCreditNote = !!invoice.credited_invoice_id
                const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
                const displayedTotal = getDisplayTotal(
                  { total: Number(invoice.total), currency: invoice.currency, ore_rounding: invoice.ore_rounding },
                  { ore_rounding: oreRounding },
                ).displayed
                const number = invoice.is_self_billed
                  ? invoiceDisplayNumber(invoice)
                  : invoice.invoice_number
                // Doc-type marker only where the view doesn't already imply it.
                const typeMarker =
                  activeTab === 'all'
                    ? docType === 'proforma'
                      ? t('badge_proforma')
                      : docType === 'delivery_note'
                        ? t('badge_delivery_note')
                        : invoice.is_self_billed
                          ? t('badge_self_billed')
                          : null
                    : null
                return (
                  <tr
                    key={invoice.id}
                    className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                    onClick={() => router.push(`/invoices/${invoice.id}`)}
                  >
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                      <Link
                        href={`/invoices/${invoice.id}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {number ?? '·'}
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                      <span className="block truncate">
                        {(invoice.customer as { name: string })?.name ?? '-'}
                      </span>
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                      {invoice.due_date && !isCreditNote && invoice.status !== 'draft'
                        ? formatDate(invoice.due_date)
                        : ''}
                    </td>
                    <td
                      className={cn(
                        TD_CLASS,
                        'whitespace-nowrap text-right tabular-nums rr-mask',
                        isCreditNote && 'text-destructive',
                      )}
                      title={
                        invoice.currency !== 'SEK' && invoice.total_sek
                          ? formatCurrency(Number(invoice.total_sek))
                          : undefined
                      }
                    >
                      {formatCurrency(displayedTotal, invoice.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      <span className="inline-flex items-center gap-1.5">
                        {typeMarker && (
                          <Badge variant="outline" className="font-normal">
                            {typeMarker}
                          </Badge>
                        )}
                        <Badge variant={chip.variant} className="font-normal">
                          {chip.label}
                        </Badge>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && visibleCount < filteredInvoices.length && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={() => setVisibleCount((count) => count + INITIAL_VISIBLE_ROWS)}
          >
            {tCommon('load_more')}
          </Button>
        </div>
      )}

      {showNewInvoice && (
        <NewInvoiceDialog
          open
          copyFromId={copyFromId}
          selfBilled={openSelfBilled}
          onOpenChange={(open) => {
            if (!open) closeNewInvoice()
          }}
        />
      )}
      {showRotRutPayout && (
        <RotRutPayoutDialog
          open
          canWrite={canWrite}
          onOpenChange={(open) => {
            if (!open) closeRotRutPayout()
          }}
        />
      )}
    </div>
  )
}
