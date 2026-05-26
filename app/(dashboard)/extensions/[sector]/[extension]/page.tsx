import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getExtensionDefinition, getSector } from '@/lib/extensions/sectors'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import {
  extensionNameKey,
  extensionDescriptionKey,
  extensionLongDescriptionKey,
  sectorNameKey,
} from '@/lib/extensions/i18n'
import type { SectorSlug } from '@/lib/extensions/types'
import CategoryBadge from '@/components/extensions/CategoryBadge'
import { WORKSPACES } from '@/lib/extensions/_generated/workspace-map'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

export default async function ExtensionDetailPage({
  params,
}: {
  params: Promise<{ sector: string; extension: string }>
}) {
  const { sector: sectorSlug, extension: extensionSlug } = await params

  const definition = getExtensionDefinition(sectorSlug, extensionSlug)
  if (!definition) notFound()

  const sector = getSector(sectorSlug as SectorSlug)

  const t = await getTranslations('extensions')

  const nameKey = extensionNameKey(definition.slug)
  const descriptionKey = extensionDescriptionKey(definition.slug)
  const longDescriptionKey = extensionLongDescriptionKey(definition.slug)
  const extensionName = nameKey ? t(nameKey) : definition.name
  const extensionDescription = descriptionKey ? t(descriptionKey) : definition.description
  const extensionLongDescription = longDescriptionKey ? t(longDescriptionKey) : definition.longDescription

  const sectorLabel = (() => {
    if (!sector) return sectorSlug
    const key = sectorNameKey(sector.slug)
    return key ? t(key) : sector.name
  })()

  const Icon = resolveIcon(definition.icon)

  const hasWorkspace = `${sectorSlug}/${extensionSlug}` in WORKSPACES

  const dataPatternLabels: Record<string, string> = {
    core: t('data_pattern_core'),
    manual: t('data_pattern_manual'),
    both: t('data_pattern_both'),
  }

  return (
    <div>
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-6">
        <Link href="/extensions" className="hover:text-foreground transition-colors">
          {t('breadcrumb')}
        </Link>
        <span>/</span>
        <Link
          href={`/extensions/${sectorSlug}`}
          className="hover:text-foreground transition-colors"
        >
          {sectorLabel}
        </Link>
        <span>/</span>
        <span className="text-foreground">{extensionName}</span>
      </nav>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-8">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 flex-shrink-0">
            <Icon className="h-7 w-7 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{extensionName}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{extensionDescription}</p>
            <div className="mt-2">
              <CategoryBadge category={definition.category} />
            </div>
          </div>
        </div>
        {hasWorkspace && (
          <Button asChild>
            <Link href={`/e/${sectorSlug}/${extensionSlug}`}>
              {t('open')}
            </Link>
          </Button>
        )}
      </div>

      {/* Details */}
      <div className="space-y-6">
        <div>
          <h2 className="text-sm font-semibold mb-2">{t('description_heading')}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {extensionLongDescription}
          </p>
        </div>

        <div>
          <h2 className="text-sm font-semibold mb-2">{t('data_source_heading')}</h2>
          <p className="text-sm text-muted-foreground">
            {dataPatternLabels[definition.dataPattern]}
          </p>
          {definition.readsCoreTables && definition.readsCoreTables.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('reads_from', { tables: definition.readsCoreTables.join(', ') })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
