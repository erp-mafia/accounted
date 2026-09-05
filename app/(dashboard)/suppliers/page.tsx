'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { useToast } from '@/components/ui/use-toast'
import { Plus, Lock, Truck } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { SuggestionsAttn } from '@/components/parties/SuggestionsAttn'
import type { Supplier, SupplierType, CreateSupplierInput } from '@/types'

const SupplierForm = dynamic(
  () => import('@/components/suppliers/SupplierForm'),
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

const SUPPLIER_TYPE_KEYS: Record<SupplierType, string> = {
  swedish_business: 'type_swedish_business',
  eu_business: 'type_eu_business',
  non_eu_business: 'type_non_eu_business',
}
const INITIAL_VISIBLE_ROWS = 100

// "Betalsätt" cell (concept scene 26): the supplier's primary payment route,
// e.g. "BG 5050-1055". First match wins, mirroring the detail page's order.
function getPaymentInfo(supplier: Supplier, t: (key: string) => string): { label: string; value: string } | null {
  if (supplier.bankgiro) return { label: t('label_bg'), value: supplier.bankgiro }
  if (supplier.plusgiro) return { label: t('label_pg'), value: supplier.plusgiro }
  if (supplier.iban) return { label: t('label_iban'), value: supplier.iban }
  if (supplier.bank_account) return { label: t('label_bank_account'), value: supplier.bank_account }
  return null
}

export default function SuppliersPage() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const t = useTranslations('suppliers')
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ROWS)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()
  const tCommon = useTranslations('common')
  const router = useRouter()

  async function fetchSuppliers() {
    if (!company) return
    setIsLoading(true)
    // Archived suppliers (v1 API soft-delete) are kept for retention but are
    // not part of the roster: same filter as /api/suppliers and the v1 list.
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('company_id', company.id)
      .is('archived_at', null)
      .order('name', { ascending: true })

    if (error) {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
    } else {
      setSuppliers(data || [])
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchSuppliers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleCreateSupplier(data: CreateSupplierInput) {
    setIsCreating(true)

    const response = await fetch('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    const result = await response.json()

    if (!response.ok) {
      const fieldErrors = result.errors?.map((e: { field: string; message: string }) => `${e.field}: ${e.message}`).join(', ')
      toast({
        title: t('create_failed_title'),
        description: fieldErrors || result.error || t('create_failed_retry'),
        variant: 'destructive',
      })
    } else {
      toast({
        title: t('created_title'),
        description: t('created_description', { name: data.name }),
      })
      setSuppliers([...suppliers, result.data])
      setIsDialogOpen(false)
    }

    setIsCreating(false)
  }

  const filteredSuppliers = suppliers.filter((s) =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.org_number?.includes(searchTerm)
  )
  const visibleSuppliers = filteredSuppliers.slice(0, visibleCount)

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 26): title + export + Ny leverantör */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <div className="flex items-center gap-2">
          <ReportExportMenu
            size="default"
            items={[
              { format: 'xlsx', href: '/api/export/suppliers' },
              { format: 'csv', href: '/api/export/suppliers?format=csv' },
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
                {t('new_supplier')}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('add_supplier')}</DialogTitle>
              </DialogHeader>
              <SupplierForm
                onSubmit={handleCreateSupplier}
                isLoading={isCreating}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <SuggestionsAttn side="supplier" />

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
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : filteredSuppliers.length === 0 ? (
        searchTerm ? (
          <EmptyState
            icon={Truck}
            title={t('no_search_results_title')}
            description={<span data-ph-mask="">{t('no_search_results_description', { term: searchTerm })}</span>}
          />
        ) : (
          <EmptyState
            icon={Truck}
            title={t('empty_title')}
            description={t('empty_description')}
            actionLabel={canWrite ? t('new_supplier') : undefined}
            onAction={canWrite ? () => setIsDialogOpen(true) : undefined}
          />
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-full')}>{t('th_name')}</th>
                  <th className={TH_CLASS}>{t('th_type')}</th>
                  <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('th_payment')}</th>
                  <th className={cn(TH_CLASS, 'hidden md:table-cell')}>{t('th_email')}</th>
                  <th className={cn(TH_CLASS, 'hidden lg:table-cell')}>{t('th_org_number')}</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {visibleSuppliers.map((supplier) => {
                  const payment = getPaymentInfo(supplier, t)
                  return (
                    <tr
                      key={supplier.id}
                      className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                      onClick={() => router.push(`/suppliers/${supplier.id}`)}
                    >
                      <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                        <Link
                          href={`/suppliers/${supplier.id}`}
                          className="block truncate hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {supplier.name}
                        </Link>
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
                        {t(SUPPLIER_TYPE_KEYS[supplier.supplier_type])}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap tabular-nums text-muted-foreground sm:table-cell')}>
                        {payment ? `${payment.label} ${payment.value}` : ''}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden max-w-[220px] truncate text-muted-foreground md:table-cell')}>
                        {supplier.email || ''}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap tabular-nums text-muted-foreground lg:table-cell')}>
                        {supplier.org_number || ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Footer note (concept pgnote) */}
          <p className="px-1 text-xs text-muted-foreground tabular-nums">
            {t('count_summary', { count: suppliers.length })}
          </p>

          {visibleCount < filteredSuppliers.length && (
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
