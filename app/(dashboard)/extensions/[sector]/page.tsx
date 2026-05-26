import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSector } from '@/lib/extensions/sectors'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { sectorNameKey, sectorDescriptionKey } from '@/lib/extensions/i18n'
import type { SectorSlug } from '@/lib/extensions/types'
import ExtensionCard from '@/components/extensions/ExtensionCard'
import Link from 'next/link'

export default async function SectorExtensionsPage({
  params,
}: {
  params: Promise<{ sector: string }>
}) {
  const { sector: sectorSlug } = await params
  const sector = getSector(sectorSlug as SectorSlug)

  if (!sector) notFound()

  const t = await getTranslations('extensions')

  const nameKey = sectorNameKey(sector.slug)
  const descriptionKey = sectorDescriptionKey(sector.slug)
  const sectorName = nameKey ? t(nameKey) : sector.name
  const sectorDescription = descriptionKey ? t(descriptionKey) : sector.description


  const Icon = resolveIcon(sector.icon)

  return (
    <div>
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-6">
        <Link href="/extensions" className="hover:text-foreground transition-colors">
          {t('breadcrumb')}
        </Link>
        <span>/</span>
        <span className="text-foreground">{sectorName}</span>
      </nav>

      {/* Header */}
      <div className="flex items-start gap-4 mb-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 flex-shrink-0">
          <Icon className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{sectorName}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{sectorDescription}</p>
        </div>
      </div>

      {/* Extensions grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {sector.extensions.map(ext => (
          <ExtensionCard key={ext.slug} extension={ext} />
        ))}
      </div>
    </div>
  )
}
