'use client'

import { useState, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useTranslations, useLocale } from 'next-intl'
import { useSuppliers } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { Button } from '@/components/ui/button'
import { PageHeaderActions } from '@/components/ui/page-header-actions'
import { ToolbarSearch, TOOLBAR_SEARCH_END_CLASS } from '@/components/ui/toolbar-search'
import { CreateDrawer } from '@/components/ui/create-drawer'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { TH_CLASS, TD_CLASS, SHOW_MORE_STEP, ShowMoreFooter } from '@/components/ui/dry-table'
import { RegisterActionsMenu } from '@/components/import/RegisterActionsMenu'
import { useToast } from '@/components/ui/use-toast'
import { LockClosedIcon, PlusIcon, TruckIcon } from '@/components/icons'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatOrgNumberDisplay, stripOrgNumberFormatting } from '@/lib/invariants/org-number'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Supplier, SupplierType, CreateSupplierInput } from '@/types'
import { dominantPartyType, partyTypeSuffix } from '@/lib/parties/list-type-suffix'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

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

/** Tie order for the list's normal type: Swedish first. */
const SUPPLIER_TYPE_ORDER: readonly SupplierType[] = ['swedish_business', 'eu_business', 'non_eu_business']

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
  const { canWrite } = useCanWrite()
  const t = useTranslations('suppliers')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  // The roster from the session cache (lib/reference-data), the list every
  // supplier picker reads: a create here refreshes them all.
  const { suppliers, isLoading, error: suppliersError, refresh: refreshSuppliers } = useSuppliers()
  // A failed first load says so in place of the rows; a failed refresh keeps
  // the rows on screen and says so in one line above them.
  const loadFailed = Boolean(suppliersError) && suppliers.length === 0
  const refreshFailed = Boolean(suppliersError) && suppliers.length > 0
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleCount, setVisibleCount] = useState(SHOW_MORE_STEP)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const { toast } = useToast()
  const router = useRouter()

  // A network error or a non-JSON 502 used to throw out of the handler and
  // leave the drawer spinning: every failure now ends in a sentence in the
  // drawer's footer, and the spinner always stops.
  async function handleCreateSupplier(data: CreateSupplierInput) {
    setIsCreating(true)
    setCreateError(null)
    try {
      const response = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      const result = await response.json().catch(() => null)

      if (!response.ok) {
        const fieldErrors = result?.errors?.map((e: { field: string; message: string }) => `${e.field}: ${e.message}`).join(', ')
        setCreateError(
          fieldErrors ||
            getErrorMessage(result, { context: 'supplier', statusCode: response.status, locale: errorLocale }),
        )
        return
      }
      toast({
        title: t('created_title'),
        description: t('created_description', { name: data.name }),
      })
      await invalidateReferenceData('ref:suppliers')
      setIsDialogOpen(false)
    } catch (err) {
      setCreateError(getErrorMessage(err, { context: 'supplier', locale: errorLocale }))
    } finally {
      setIsCreating(false)
    }
  }

  // org_number is stored as 10 digits and shown as XXXXXX-XXXX, so the search
  // compares without separators: '556677-88' finds '5566778899'.
  const orgSearchTerm = stripOrgNumberFormatting(searchTerm)
  const filteredSuppliers = suppliers.filter((s) =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (orgSearchTerm !== '' && s.org_number
      ? stripOrgNumberFormatting(s.org_number).includes(orgSearchTerm)
      : false)
  )
  const visibleSuppliers = filteredSuppliers.slice(0, visibleCount)
  // The Typ column said "Svenskt företag eller organisation" on nearly every
  // row: the whole register's most common type goes unsaid, and a row of
  // another type carries it after the name.
  const dominantType = useMemo(
    () => dominantPartyType(suppliers.map((s) => s.supplier_type), SUPPLIER_TYPE_ORDER),
    [suppliers],
  )

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 26): title + import/export menu + Ny leverantör */}
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="page-header-title">{t('title')}</h1>
        <PageHeaderActions className="flex flex-wrap items-center justify-end gap-2">
          <RegisterActionsMenu entity="suppliers" />
          <Button
            size="toolbar"
            disabled={!canWrite}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            onClick={() => setIsDialogOpen(true)}
          >
            {canWrite ? (
              <PlusIcon className="h-4 w-4" />
            ) : (
              <LockClosedIcon className="h-4 w-4" />
            )}
            {t('new_supplier')}
          </Button>
          {/* A small record is created in a drawer over its list (V7 creation
              forms): the list stays in place behind it. */}
          <CreateDrawer
            open={isDialogOpen}
            onOpenChange={(open) => {
              setIsDialogOpen(open)
              if (!open) setCreateError(null)
            }}
            title={t('new_supplier')}
            formId="create-supplier-form"
            submitLabel={t('create_submit')}
            submitting={isCreating}
            error={createError}
          >
            <SupplierForm
              onSubmit={handleCreateSupplier}
              isLoading={isCreating}
              formId="create-supplier-form"
            />
          </CreateDrawer>
        </PageHeaderActions>
      </div>

      {/* Toolbar: search at the right end (V7 list toolbars) */}
      <div className="flex flex-wrap items-center gap-2">
        <ToolbarSearch
          containerClassName={TOOLBAR_SEARCH_END_CLASS}
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value)
            setVisibleCount(SHOW_MORE_STEP)
          }}
        />
      </div>

      {refreshFailed && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void refreshSuppliers() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      )}

      {isLoading ? (
        <LateReveal>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex h-11 items-center gap-8 border-b-hairline">
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="ml-auto hidden h-3.5 w-28 sm:block" />
              <Skeleton className="hidden h-3.5 w-40 md:block" />
              <Skeleton className="hidden h-3.5 w-24 lg:block" />
            </div>
          ))}
        </LateReveal>
      ) : loadFailed ? (
        <LoadError title={t('load_failed_title')} onRetry={() => void refreshSuppliers()} />
      ) : filteredSuppliers.length === 0 ? (
        searchTerm ? (
          <div className="flex flex-wrap items-center gap-x-3 py-3 text-[13px] text-muted-foreground">
            <span data-ph-mask="">{t('no_search_results_description', { term: searchTerm })}</span>
            <Button variant="link" onClick={() => setSearchTerm('')}>
              {tCommon('clear_search')}
            </Button>
          </div>
        ) : (
          <EmptyState
            icon={TruckIcon}
            title={t('empty_title')}
            description={t('empty_description')}
            actionLabel={canWrite ? t('new_supplier') : undefined}
            onAction={canWrite ? () => setIsDialogOpen(true) : undefined}
          />
        )
      ) : (
        <>
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-full')}>{t('th_name')}</th>
                  <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('th_payment')}</th>
                  <th className={cn(TH_CLASS, 'hidden md:table-cell')}>{t('th_email')}</th>
                  <th className={cn(TH_CLASS, 'hidden lg:table-cell')}>{t('th_org_number')}</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {visibleSuppliers.map((supplier) => {
                  const payment = getPaymentInfo(supplier, t)
                  const typeSuffix = partyTypeSuffix(supplier.supplier_type, dominantType)
                  return (
                    <tr
                      key={supplier.id}
                      className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                      onClick={() => router.push(`/suppliers/${supplier.id}`)}
                    >
                      <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                        <span className="flex min-w-0 items-baseline gap-2">
                          <Link
                            href={`/suppliers/${supplier.id}`}
                            className="min-w-0 truncate hover:underline"
                            title={supplier.name}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {supplier.name}
                          </Link>
                          {typeSuffix && SUPPLIER_TYPE_KEYS[typeSuffix] && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t(SUPPLIER_TYPE_KEYS[typeSuffix])}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap tabular-nums text-muted-foreground sm:table-cell')}>
                        {payment ? `${payment.label} ${payment.value}` : ''}
                      </td>
                      {/* The cap sits on an inner block, not the td: max-width
                          on a table cell is undefined per CSS 2.1 10.4 and
                          Firefox ignores it when sizing columns, so a long
                          address widened the table there. 204 = the old 220
                          minus the cell's px-2, which the border-box cap on
                          the td used to include, so the column is unchanged. */}
                      <td className={cn(TD_CLASS, 'hidden text-muted-foreground md:table-cell')} title={supplier.email || undefined}>
                        <div className="max-w-[204px] truncate">{supplier.email || ''}</div>
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap tabular-nums text-muted-foreground lg:table-cell')}>
                        {formatOrgNumberDisplay(supplier.org_number)}
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

          <ShowMoreFooter
            shown={visibleCount}
            total={filteredSuppliers.length}
            onMore={() => setVisibleCount((count) => count + SHOW_MORE_STEP)}
          />
        </>
      )}
    </div>
  )
}
