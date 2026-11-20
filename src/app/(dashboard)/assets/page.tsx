'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { CubeIcon, PlusIcon } from '@/components/icons'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { Asset, AssetCategory } from '@/types'
import { CreateAssetDialog } from '@/components/bookkeeping/assets/CreateAssetDialog'
import { EditAssetDialog } from '@/components/bookkeeping/assets/EditAssetDialog'
import { useViewerLock } from '@/components/ui/viewer-lock'

/** GET /api/assets annotates each row with whether depreciation has posted
 *  and whether the row may be deleted (never reached the books). */
type AssetRow = Asset & { has_posted_depreciation?: boolean; deletable?: boolean }

const CATEGORY_LABEL_KEYS: Record<AssetCategory, string> = {
  immaterial: 'category_immaterial',
  building: 'category_building',
  land: 'category_land',
  land_improvement: 'category_land_improvement',
  machinery: 'category_machinery',
  equipment: 'category_equipment',
  vehicle: 'category_vehicle',
  computer: 'category_computer',
  other_tangible: 'category_other_tangible',
}

export default function AssetsPage() {
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  // The top bar says what the menu row says (design.md convention 2).
  const tNav = useTranslations('nav')
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite, lockedTitle } = useViewerLock()
  const { dialogProps: confirmProps, confirm } = useDestructiveConfirm()
  const [assets, setAssets] = useState<AssetRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AssetRow | null>(null)

  const [reloadKey, setReloadKey] = useState(0)
  const retryLoad = useCallback(() => {
    setError(null)
    setReloadKey((k) => k + 1)
  }, [])

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

  // Only offered on rows the list marked deletable: never posted, never
  // disposed. The server enforces the same rule (409 ASSET_DELETE_BLOCKED),
  // and the confirm runs the DELETE inside the dialog so it shows its own
  // pending state and closes when the call settles.
  const handleDelete = useCallback(
    async (asset: AssetRow) => {
      const ok = await confirm(
        {
          title: t('delete_confirm_title'),
          description: t('delete_confirm_description', { name: asset.name }),
          confirmLabel: t('action_delete'),
        },
        async () => {
          const res = await fetch(`/api/assets/${asset.id}`, { method: 'DELETE' })
          if (!res.ok) {
            const body = await res.json().catch(() => null)
            toast({
              title: t('delete_failed_title'),
              description: getErrorMessage(body?.error ?? body),
              variant: 'destructive',
            })
            throw new Error('asset delete failed')
          }
        },
      )
      if (!ok) return
      toast({ title: t('delete_success_title'), description: asset.name })
      setEditing(null)
      setReloadKey((k) => k + 1)
    },
    [confirm, t, toast],
  )

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 29): title + Ny tillgång */}
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="page-header-title">{tNav('v3_assets')}</h1>
        <Button size="toolbar" onClick={() => setDialogOpen(true)} disabled={!canWrite} title={lockedTitle}>
          <PlusIcon className="h-4 w-4" />
          {t('new_asset')}
        </Button>
      </div>

      {assets === null && !error && (
        <LateReveal>
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex h-11 items-center gap-6 border-b-hairline">
              <Skeleton className="h-3.5 w-64" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="ml-auto h-3.5 w-20" />
            </div>
          ))}
        </LateReveal>
      )}

      {error && assets === null && <LoadError title={error} onRetry={retryLoad} />}

      {error && assets !== null && (
        <AttnLine action={{ label: tCommon('retry'), onClick: retryLoad }}>{tCommon('refresh_failed')}</AttnLine>
      )}

      {assets !== null && assets.length === 0 && (
        <EmptyState
          icon={CubeIcon}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={canWrite ? t('new_asset') : undefined}
          onAction={canWrite ? () => setDialogOpen(true) : undefined}
        />
      )}

      {assets !== null && assets.length > 0 && (
        <>
          <div className="-mx-2 overflow-x-auto">
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
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right date-figures text-muted-foreground sm:table-cell')}>
                        {formatDate(asset.acquisition_date)}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                        {formatRowAmount(Number(asset.acquisition_cost))}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground md:table-cell')}>
                        {asset.k3_components && asset.k3_components.length > 0
                          ? t('components.count', { count: asset.k3_components.length })
                          : asset.category === 'land'
                            ? t('not_depreciated')
                            : t('useful_life_format', { years, months: asset.useful_life_months })}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right date-figures')}>
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
                          <span className={cn('inline-flex items-center gap-4', HOVER_REVEAL_CLASS)}>
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
                              disabled={!canWrite}
                              title={lockedTitle}
                            >
                              {t('action_dispose')}
                            </button>
                            {asset.deletable && (
                              <button
                                type="button"
                                className={cn(QUIET_LINK_CLASS, 'text-destructive')}
                                onClick={() => void handleDelete(asset)}
                                disabled={!canWrite}
                                title={lockedTitle}
                              >
                                {t('action_delete')}
                              </button>
                            )}
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
          onDelete={editing.deletable ? () => void handleDelete(editing) : undefined}
        />
      )}

      <DestructiveConfirmDialog {...confirmProps} />
    </div>
  )
}
