'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Package, Plus } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { Asset, AssetCategory } from '@/types'
import { CreateAssetDialog } from '@/components/bookkeeping/assets/CreateAssetDialog'

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
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

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
        const { data } = (await res.json()) as { data: Asset[] }
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

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> {t('new_asset')}
          </Button>
        }
      />

      {assets === null && !error && (
        <Card>
          <CardContent className="p-6 space-y-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardContent className="p-6 text-destructive">{error}</CardContent>
        </Card>
      )}

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
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('th_name')}</TableHead>
                  <TableHead>{t('th_category')}</TableHead>
                  <TableHead>{t('th_acquired')}</TableHead>
                  <TableHead className="text-right">{t('th_acquisition_cost')}</TableHead>
                  <TableHead>{t('th_useful_life')}</TableHead>
                  <TableHead>{t('th_status')}</TableHead>
                  <TableHead className="text-right">{t('th_actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((asset) => {
                  const years = Math.round(asset.useful_life_months / 12)
                  return (
                    <TableRow key={asset.id}>
                      <TableCell className="font-medium">{asset.name}</TableCell>
                      <TableCell className="text-sm">{t(CATEGORY_LABEL_KEYS[asset.category])}</TableCell>
                      <TableCell className="tabular-nums">
                        {formatDate(asset.acquisition_date)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(Number(asset.acquisition_cost))}
                      </TableCell>
                      <TableCell className="text-sm">
                        {t('useful_life_format', { years, months: asset.useful_life_months })}
                      </TableCell>
                      <TableCell>
                        {asset.disposed_at ? (
                          <div className="flex flex-col gap-1">
                            <Badge variant="secondary">{t('status_disposed')}</Badge>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {formatDate(asset.disposed_at)}
                            </span>
                          </div>
                        ) : (
                          <Badge variant="success">{t('status_active')}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {!asset.disposed_at && (
                          <Link href={`/assets/${asset.id}/dispose`}>
                            <Button variant="ghost" size="sm">
                              {t('action_dispose')}
                            </Button>
                          </Link>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CreateAssetDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreated={handleCreated} />
    </div>
  )
}
