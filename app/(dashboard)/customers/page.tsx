'use client'

import { useState, useEffect, useMemo, useCallback, Suspense } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { Plus, Search, Users, Lock, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import CustomerForm from '@/components/customers/CustomerForm'
import { EmptyCustomers, EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { formatDate } from '@/lib/utils'
import Link from 'next/link'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Customer, CustomerType, CreateCustomerInput } from '@/types'

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

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function getIdentifier(customer: Customer): string {
  return customer.org_number || customer.personal_number || ''
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, 'sv', { sensitivity: 'base' })
}

function CustomersPageInner() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('customers')
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

  async function fetchCustomers() {
    if (!company) return
    setIsLoading(true)
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('company_id', company.id)
      .order('name', { ascending: true })

    if (error) {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
    } else {
      setCustomers(data || [])
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchCustomers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      setCustomers([...customers, result.data])
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
      <TableHead className={className}>
        <button
          type="button"
          onClick={() => updateSort(column)}
          className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          {label}
          <Icon className="h-3 w-3 opacity-70" aria-hidden="true" />
        </button>
      </TableHead>
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
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
              />
            </DialogContent>
          </Dialog>
        }
      />

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Customer list */}
      {isLoading ? (
        <>
          {/* Desktop skeleton */}
          <Card className="hidden md:block">
            <CardContent className="p-6 space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </CardContent>
          </Card>
          {/* Mobile skeleton */}
          <div className="grid gap-4 md:hidden">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="h-4 w-1/3 mt-2" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-4 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : sortedCustomers.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            {searchTerm ? (
              <EmptyState
                icon={Users}
                title={t('no_search_results_title')}
                description={t('no_search_results_description', { term: searchTerm })}
              />
            ) : (
              <EmptyCustomers onAction={() => setIsDialogOpen(true)} />
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader column="name" label={t('col_name')} />
                    <SortableHeader column="customer_type" label={t('col_type')} />
                    <SortableHeader column="identifier" label={t('col_identifier')} />
                    <SortableHeader column="email" label={t('col_email')} />
                    <SortableHeader column="city" label={t('col_city')} />
                    <SortableHeader
                      column="created_at"
                      label={t('col_created')}
                      className="text-right"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedCustomers.map((customer) => {
                    const identifier = getIdentifier(customer)
                    return (
                      <TableRow
                        key={customer.id}
                        className="cursor-pointer"
                        onClick={() => router.push(`/customers/${customer.id}`)}
                      >
                        <TableCell className="font-medium">
                          <Link
                            href={`/customers/${customer.id}`}
                            className="hover:text-primary transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {customer.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {t(CUSTOMER_TYPE_LABEL_KEYS[customer.customer_type])}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <span>{identifier || '—'}</span>
                            {customer.org_number && customer.vat_number_validated && (
                              <Badge variant="success" className="text-xs">
                                {t('verified')}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground truncate max-w-[220px]">
                          {customer.email || '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {customer.city || '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatDate(customer.created_at)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Mobile card list */}
          <div className="grid gap-4 md:hidden">
            {sortedCustomers.map((customer) => (
              <Link key={customer.id} href={`/customers/${customer.id}`}>
                <Card className="cursor-pointer transition-colors duration-150 hover:bg-secondary/60 h-full group">
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3.5">
                      <div className="h-11 w-11 rounded-full bg-secondary flex items-center justify-center shrink-0 text-sm font-semibold tracking-tight">
                        {getInitials(customer.name)}
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-base truncate group-hover:text-primary transition-colors">
                          {customer.name}
                        </CardTitle>
                        <Badge variant="secondary" className="mt-1">
                          {t(CUSTOMER_TYPE_LABEL_KEYS[customer.customer_type])}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1.5 text-sm text-muted-foreground">
                      {customer.email && <p className="truncate">{customer.email}</p>}
                      {getIdentifier(customer) && (
                        <div className="flex items-center gap-2 tabular-nums">
                          <span>{getIdentifier(customer)}</span>
                          {customer.org_number && customer.vat_number_validated && (
                            <Badge variant="success" className="text-xs">
                              {t('verified')}
                            </Badge>
                          )}
                        </div>
                      )}
                      {customer.city && (
                        <p>
                          {customer.city}, {customer.country}
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <CustomersPageInner />
    </Suspense>
  )
}
