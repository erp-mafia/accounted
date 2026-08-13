import { getTranslations } from 'next-intl/server'
import { SECTORS } from '@/lib/extensions/sectors'
import { sectorNameKey } from '@/lib/extensions/i18n'
import { PageHeader } from '@/components/ui/page-header'
import ExtensionCard from '@/components/extensions/ExtensionCard'
import SectorCard from '@/components/extensions/SectorCard'

export default async function ExtensionsPage() {
  const t = await getTranslations('extensions')
  const generalSector = SECTORS.find(s => s.slug === 'general')
  // Only sectors that actually ship extensions: a shell with zero extensions
  // would render a dead card and an empty grid.
  const industrySectors = SECTORS.filter(s => s.slug !== 'general' && s.extensions.length > 0)

  const generalSectorName = (() => {
    if (!generalSector) return ''
    const key = sectorNameKey(generalSector.slug)
    return key ? t(key) : generalSector.name
  })()

  return (
    <div className="space-y-8">
      <PageHeader title={t('page_title')} />

      {/* General extensions */}
      {generalSector && (
        <section>
          <h2 className="text-sm uppercase tracking-wider text-muted-foreground mb-4">
            {generalSectorName}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 stagger-enter">
            {generalSector.extensions.map(ext => (
              <ExtensionCard key={ext.slug} extension={ext} />
            ))}
          </div>
        </section>
      )}

      {/* Industry sectors (hidden while no industry sector ships extensions) */}
      {industrySectors.length > 0 && (
        <section>
          <h2 className="text-sm uppercase tracking-wider text-muted-foreground mb-4">
            {t('industry_tools')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 stagger-enter">
            {industrySectors.map(sector => (
              <SectorCard key={sector.slug} sector={sector} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
