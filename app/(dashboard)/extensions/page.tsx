import { getTranslations } from 'next-intl/server'
import { SECTORS } from '@/lib/extensions/sectors'
import { sectorNameKey } from '@/lib/extensions/i18n'
import ExtensionCard from '@/components/extensions/ExtensionCard'
import SectorCard from '@/components/extensions/SectorCard'

export default async function ExtensionsPage() {
  const t = await getTranslations('extensions')
  const generalSector = SECTORS.find(s => s.slug === 'general')
  const industrySectors = SECTORS.filter(s => s.slug !== 'general')

  const generalSectorName = (() => {
    if (!generalSector) return ''
    const key = sectorNameKey(generalSector.slug)
    return key ? t(key) : generalSector.name
  })()

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">{t('page_title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('page_description')}
        </p>
      </div>

      {/* General extensions */}
      {generalSector && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
            {generalSectorName}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {generalSector.extensions.map(ext => (
              <ExtensionCard key={ext.slug} extension={ext} />
            ))}
          </div>
        </section>
      )}

      {/* Industry sectors */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          {t('industry_tools')}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {industrySectors.map(sector => (
            <SectorCard key={sector.slug} sector={sector} />
          ))}
        </div>
      </section>
    </div>
  )
}
