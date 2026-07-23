'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { Package, Plus } from 'lucide-react'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { Asset, AssetCategory } from '@/types'
import { CreateAssetDialog } from '@/components/bookkeeping/assets/CreateAssetDialog'
import { EditAssetDialog } from '@/components/bookkeeping/assets/EditAssetDialog'

/** GET /api/assets annotates each row with whether depreciation has posted. */
type AssetRow = Asset & { has_posted_depreciation?: boolean }

const CATEGORY_LABEL_KEYS: Record<AssetCategory, string> = {
  immaterial: 'category_immaterial',
  building: 'category_building',
  land_improvement: 'category_land_improvement',
  machinery: 'category_machinery',
  equipment: 'category_equipment',
  vehicle: 'category_vehicle',
  computer: 'category_computer',
  other_tangible: 'category_other_tangible',
}

export default function AssetsPage() {
  const t = useTranslations('assets')
  const router = useRouter()
  const [assets, setAssets] = useState<AssetRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AssetRow | null>(null)

  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch('/api/assets')
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setError(t('load_failed'))
          return
        }
        const { data } = (await res.json()) as { data: AssetRow[] }
        if (cancelled) return
        setError(null)
        setAssets(data)
      })
      .catch(() => {
        if (!cancelled) setError(t('load_failed'))
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey, t])

  const handleCreated = useCallback(() => {
    setDialogOpen(false)
    setReloadKey((k) => k + 1)
  }, [])

  const handleSaved = useCallback(() => {
    setEditing(null)
    setReloadKey((k) => k + 1)
  }, [])

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 29): title + Ny tillgång */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('new_asset')}
        </Button>
      </div>

      {assets === null && !error && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {assets !== null && assets.length === 0 && (
        <EmptyState
          icon={Package}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={t('new_asset')}
          onAction={() => setDialogOpen(true)}
        />
      )}

      {assets !== null && assets.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-full')}>{t('th_name')}</th>
                  <th className={cn(TH_CLASS, 'hidden md:table-cell')}>{t('th_category')}</th>
                  <th className={cn(TH_CLASS, 'hidden text-right sm:table-cell')}>{t('th_acquired')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('th_acquisition_cost')}</th>
                  <th className={cn(TH_CLASS, 'hidden text-right md:table-cell')}>{t('th_useful_life')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('th_status')}</th>
                  <th className={cn(TH_CLASS, 'w-[120px]')} aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {assets.map((asset) => {
                  const years = Math.round(asset.useful_life_months / 12)
                  const disposed = !!asset.disposed_at
                  return (
                    <tr
                      key={asset.id}
                      className={cn(
                        'group transition-colors duration-150 hover:bg-secondary/35',
                        !disposed && 'cursor-pointer',
                      )}
                      onClick={!disposed ? () => setEditing(asset) : undefined}
                    >
                      <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                        <span className="block truncate">{asset.name}</span>
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-muted-foreground md:table-cell')}>
                        {t(CATEGORY_LABEL_KEYS[asset.category])}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                        {formatDate(asset.acquisition_date)}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                        {formatCurrency(Number(asset.acquisition_cost))}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground md:table-cell')}>
                        {t('useful_life_format', { years, months: asset.useful_life_months })}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                        {disposed ? (
                          <span className="inline-flex items-center gap-2">
                            <Badge variant="secondary" className="font-normal">
                              {t('status_disposed')}
                            </Badge>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {formatDate(asset.disposed_at!)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{t('status_active')}</span>
                        )}
                      </td>
                      {/* Row actions as hover-revealed quiet links (concept) */}
                      <td
                        className={cn(TD_CLASS, 'whitespace-nowrap text-right')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {!disposed && (
                          <span className="inline-flex items-center gap-4 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                            <button
                              type="button"
                              className={QUIET_LINK_CLASS}
                              onClick={() => setEditing(asset)}
                            >
                              {t('action_edit')}
                            </button>
                            <button
                              type="button"
                              className={QUIET_LINK_CLASS}
                              onClick={() => router.push(`/assets/${asset.id}/dispose`)}
                            >
                              {t('action_dispose')}
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Footer count (concept pgnote) */}
          <p className="px-1 text-xs text-muted-foreground tabular-nums">
            {t('count_footer', { count: assets.length })}
          </p>
        </>
      )}

      <CreateAssetDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreated={handleCreated} />

      {editing && (
        <EditAssetDialog
          key={editing.id}
          asset={editing}
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
