'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { useToast } from '@/components/ui/use-toast'
import { Plus, Search, Building2, Lock } from 'lucide-react'
import SupplierForm from '@/components/suppliers/SupplierForm'
import Link from 'next/link'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Supplier, SupplierType, CreateSupplierInput } from '@/types'

const SUPPLIER_TYPE_KEYS: Record<SupplierType, string> = {
  swedish_business: 'type_swedish_business',
  eu_business: 'type_eu_business',
  non_eu_business: 'type_non_eu_business',
}

function getPaymentInfo(supplier: Supplier, t: (key: string) => string): { label: string; value: string } | null {
  if (supplier.bankgiro) return { label: t('label_bg'), value: supplier.bankgiro }
  if (supplier.plusgiro) return { label: t('label_pg'), value: supplier.plusgiro }
  if (supplier.iban) return { label: t('label_iban'), value: supplier.iban }
  if (supplier.bank_account) return { label: t('label_bank_account'), value: supplier.bank_account }
  return null
}

function formatLocation(supplier: Supplier): string | null {
  if (supplier.city && supplier.country) return `${supplier.city}, ${supplier.country}`
  if (supplier.city) return supplier.city
  return null
}

export default function SuppliersPage() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const t = useTranslations('suppliers')
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()

  async function fetchSuppliers() {
    if (!company) return
    setIsLoading(true)
    const { data, error } = await supabase
      .from('suppliers')
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
      setSuppliers(data || [])
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchSuppliers()
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

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl md:text-3xl tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ReportExportMenu
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

      {/* Supplier list */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-6 space-y-3">
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-3 w-2/3" />
                <div className="h-px bg-muted" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredSuppliers.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            {searchTerm ? (
              <EmptyState
                icon={Building2}
                title={t('no_search_results_title')}
                description={t('no_search_results_description', { term: searchTerm })}
              />
            ) : (
              <EmptyState
                icon={Building2}
                title={t('empty_title')}
                description={t('empty_description')}
                actionLabel={canWrite ? t('new_supplier') : undefined}
                onAction={canWrite ? () => setIsDialogOpen(true) : undefined}
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredSuppliers.map((supplier) => {
            const payment = getPaymentInfo(supplier, t)
            const location = formatLocation(supplier)
            return (
              <Link key={supplier.id} href={`/suppliers/${supplier.id}`} className="group">
                <Card className="h-full cursor-pointer transition-colors duration-150 hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                  <CardContent className="p-6 flex flex-col h-full">
                    <div className="space-y-1 mb-4">
                      <h3 className="text-[15px] font-semibold tracking-tight leading-tight truncate group-hover:text-primary transition-colors">
                        {supplier.name}
                      </h3>
                      <p className="text-xs text-muted-foreground leading-snug">
                        {t(SUPPLIER_TYPE_KEYS[supplier.supplier_type])}
                      </p>
                    </div>

                    <dl className="mt-auto space-y-2 text-sm border-t pt-3">
                      {supplier.org_number && (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-xs text-muted-foreground shrink-0">{t('label_org_number')}</dt>
                          <dd className="tabular-nums truncate">{supplier.org_number}</dd>
                        </div>
                      )}
                      {payment && (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-xs text-muted-foreground shrink-0">{payment.label}</dt>
                          <dd className="tabular-nums truncate">{payment.value}</dd>
                        </div>
                      )}
                      {supplier.email && (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-xs text-muted-foreground shrink-0">{t('label_email')}</dt>
                          <dd className="truncate">{supplier.email}</dd>
                        </div>
                      )}
                      {location && (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-xs text-muted-foreground shrink-0">{t('label_location')}</dt>
                          <dd className="truncate">{location}</dd>
                        </div>
                      )}
                      {!supplier.org_number && !payment && !supplier.email && !location && (
                        <p className="text-xs text-muted-foreground italic">{t('no_contact_info')}</p>
                      )}
                    </dl>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
