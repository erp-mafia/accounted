'use client'

import { useState, useEffect, useMemo, useCallback, Suspense } from 'react'
import { useCompanySettings, useCustomers } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import dynamic from 'next/dynamic'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { Plus, Users, Lock, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { EmptyCustomers, EmptyState } from '@/components/ui/empty-state'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { SuggestionsAttn } from '@/components/parties/SuggestionsAttn'
import type { Customer, CustomerType, CreateCustomerInput } from '@/types'
import { customerListIdentifier } from '@/lib/customers/mask-personal-number'

const CustomerForm = dynamic(
  () => import('@/components/customers/CustomerForm'),
  {
    loading: () => (
      <div className="space-y-4 py-4" role="status">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    ),
  },
)

const CUSTOMER_TYPE_LABEL_KEYS: Record<CustomerType, string> = {
  individual: 'type_individual',
  swedish_business: 'type_swedish_business',
  eu_business: 'type_eu_business',
  non_eu_business: 'type_non_eu_business',
}

type SortColumn = 'name' | 'customer_type' | 'identifier' | 'email' | 'city' | 'created_at'
type SortDir = 'asc' | 'desc'

const SORTABLE_COLUMNS: ReadonlyArray<SortColumn> = [
  'name',
  'customer_type',
  'identifier',
  'email',
  'city',
  'created_at',
]
const INITIAL_VISIBLE_ROWS = 100

// Business rows show org_number; individual rows show the masked
// personnummer the API returns, and a legacy individual row that still
// carries its personnummer in org_number shows that masked too, never raw.
function getIdentifier(customer: Customer): string {
  return customerListIdentifier(customer)
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, 'sv', { sensitivity: 'base' })
}

function CustomersPageInner() {
  const { canWrite } = useCanWrite()
  // The roster from the session cache (lib/reference-data): /api/customers
  // masks the personnummer column server-side (see the note that used to sit
  // on fetchCustomers), the list is shared with every customer picker, and
  // a revisit renders from cache. Skeleton only on the very first load.
  const { customers, isLoading: customersLoading, error: customersError } = useCustomers()
  const isLoading = customersLoading && customers.length === 0
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ROWS)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  // Company default payment terms (Inställningar → Fakturering). Prefilled
  // into the new-customer form so it opens on the company's own default
  // instead of a hardcoded 30.
  // Default payment terms from the session-cached settings row; the dialog
  // falls back to 30 until (or unless) the company set one.
  const { settings: companySettings } = useCompanySettings()
  const companyDefaultTerms =
    typeof companySettings?.invoice_default_days === 'number' && companySettings.invoice_default_days > 0
      ? companySettings.invoice_default_days
      : null
  const { toast } = useToast()
  const t = useTranslations('customers')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const sortParam = searchParams.get('sort')
  const dirParam = searchParams.get('dir')
  const sortColumn: SortColumn = (SORTABLE_COLUMNS as ReadonlyArray<string>).includes(sortParam ?? '')
    ? (sortParam as SortColumn)
    : 'name'
  const sortDir: SortDir = dirParam === 'desc' ? 'desc' : 'asc'

  const updateSort = useCallback(
    (column: SortColumn) => {
      setVisibleCount(INITIAL_VISIBLE_ROWS)
      const params = new URLSearchParams(searchParams.toString())
      let nextDir: SortDir = 'asc'
      if (column === sortColumn) {
        nextDir = sortDir === 'asc' ? 'desc' : 'asc'
      }
      params.set('sort', column)
      params.set('dir', nextDir)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [searchParams, sortColumn, sortDir, router, pathname]
  )

  useEffect(() => {
    if (!customersError) return
    toast({
      title: t('load_failed_title'),
      description: t('load_failed_description'),
      variant: 'destructive',
    })
  }, [customersError, toast, t])

  async function handleCreateCustomer(data: CreateCustomerInput) {
    setIsCreating(true)

    const response = await fetch('/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    const result = await response.json()

    if (!response.ok) {
      toast({
        title: t('create_failed_title'),
        description: getErrorMessage(result, { context: 'customer', locale: errorLocale }),
        variant: 'destructive',
      })
    } else {
      toast({
        title: t('created_title'),
        description: t('created_description', { name: data.name }),
      })
      // Every picker shares the cached list: refresh it instead of patching
      // this page's copy.
      await invalidateReferenceData('ref:customers')
      setIsDialogOpen(false)
    }

    setIsCreating(false)
  }

  const filteredCustomers = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return customers
    return customers.filter((c) => {
      return (
        c.name.toLowerCase().includes(term) ||
        c.email?.toLowerCase().includes(term) ||
        c.org_number?.includes(term) ||
        // The masked form, so this matches the last four digits. Against the
        // raw ciphertext it matched nothing, which read as "search is broken"
        // for anyone looking up a private customer by personnummer.
        c.personal_number?.includes(term) ||
        c.city?.toLowerCase().includes(term) ||
        c.notes?.toLowerCase().includes(term)
      )
    })
  }, [customers, searchTerm])

  const sortedCustomers = useMemo(() => {
    const arr = [...filteredCustomers]
    arr.sort((a, b) => {
      let av = ''
      let bv = ''
      switch (sortColumn) {
        case 'name':
          av = a.name || ''
          bv = b.name || ''
          break
        case 'customer_type':
          av = a.customer_type || ''
          bv = b.customer_type || ''
          break
        case 'identifier':
          av = getIdentifier(a)
          bv = getIdentifier(b)
          break
        case 'email':
          av = a.email || ''
          bv = b.email || ''
          break
        case 'city':
          av = a.city || ''
          bv = b.city || ''
          break
        case 'created_at':
          av = a.created_at || ''
          bv = b.created_at || ''
          break
      }
      const cmp = compareStrings(av, bv)
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [filteredCustomers, sortColumn, sortDir])
  const visibleCustomers = sortedCustomers.slice(0, visibleCount)

  // Sortable dry-table head: the button inherits the uppercase hairline
  // styling from TH_CLASS on the th.
  function SortableHeader({
    column,
    label,
    className,
  }: {
    column: SortColumn
    label: string
    className?: string
  }) {
    const isActive = sortColumn === column
    const Icon = isActive ? (sortDir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown
    return (
      <th className={cn(TH_CLASS, className)}>
        <button
          type="button"
          onClick={() => updateSort(column)}
          className="inline-flex items-center gap-1 uppercase transition-colors duration-150 hover:text-foreground"
        >
          {label}
          <Icon className="h-3 w-3 opacity-70" aria-hidden="true" />
        </button>
      </th>
    )
  }

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 25): title + export + Ny kund */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <div className="flex items-center gap-2">
          <ReportExportMenu
            size="default"
            items={[
              { format: 'xlsx', href: '/api/export/customers' },
              { format: 'csv', href: '/api/export/customers?format=csv' },
            ]}
          />
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button
                disabled={!canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? (
                  <Plus className="mr-2 h-4 w-4" />
                ) : (
                  <Lock className="mr-2 h-4 w-4" />
                )}
                {t('new_customer')}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('add_customer')}</DialogTitle>
              </DialogHeader>
              <CustomerForm
                onSubmit={handleCreateCustomer}
                isLoading={isCreating}
                initialData={
                  companyDefaultTerms !== null
                    ? { default_payment_terms: companyDefaultTerms }
                    : undefined
                }
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <SuggestionsAttn side="customer" />

      {/* Toolbar: search (concept) */}
      <div className="flex flex-wrap items-center gap-2">
        <ToolbarSearch
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value)
            setVisibleCount(INITIAL_VISIBLE_ROWS)
          }}
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : sortedCustomers.length === 0 ? (
        searchTerm ? (
          <EmptyState
            icon={Users}
            title={t('no_search_results_title')}
            description={<span data-ph-mask="">{t('no_search_results_description', { term: searchTerm })}</span>}
          />
        ) : (
          <EmptyCustomers onAction={() => setIsDialogOpen(true)} />
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <SortableHeader column="name" label={t('col_name')} className="w-full" />
                  <SortableHeader column="customer_type" label={t('col_type')} />
                  <SortableHeader
                    column="identifier"
                    label={t('col_identifier')}
                    className="hidden lg:table-cell"
                  />
                  <SortableHeader
                    column="email"
                    label={t('col_email')}
                    className="hidden md:table-cell"
                  />
                  <SortableHeader
                    column="city"
                    label={t('col_city')}
                    className="hidden sm:table-cell"
                  />
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {visibleCustomers.map((customer) => {
                  const identifier = getIdentifier(customer)
                  return (
                    <tr
                      key={customer.id}
                      className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                      onClick={() => router.push(`/customers/${customer.id}`)}
                    >
                      <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                        <span className="flex min-w-0 items-center gap-2">
                          <Link
                            href={`/customers/${customer.id}`}
                            className="truncate hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {customer.name}
                          </Link>
                          {customer.org_number && customer.vat_number_validated && (
                            <Badge variant="success" className="shrink-0 font-normal">
                              {t('verified')}
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
                        {t(CUSTOMER_TYPE_LABEL_KEYS[customer.customer_type])}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap tabular-nums text-muted-foreground lg:table-cell')}>
                        {identifier || ''}
                      </td>
                      {/* See the suppliers list: the cap must sit on an inner
                          block because Firefox ignores max-width on a td, and
                          188 = 220 minus the cell's px-4. */}
                      <td className={cn(TD_CLASS, 'hidden text-muted-foreground md:table-cell')}>
                        <div className="max-w-[188px] truncate">{customer.email || ''}</div>
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-muted-foreground sm:table-cell')}>
                        {customer.city || ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Footer note (concept pgnote) */}
          <p className="px-1 text-xs text-muted-foreground tabular-nums">
            {t('count_summary', { count: customers.length })}
          </p>

          {visibleCount < sortedCustomers.length && (
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
        </>
      )}
    </div>
  )
}

export default function CustomersPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-10 w-32" />
          </div>
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </div>
      }
    >
      <CustomersPageInner />
    </Suspense>
  )
}
