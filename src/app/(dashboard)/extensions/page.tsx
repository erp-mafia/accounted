import { getTranslations } from 'next-intl/server'
import { getAllExtensions } from '@/lib/extensions/sectors'
import { PageHeader } from '@/components/ui/page-header'
import ExtensionCard from '@/components/extensions/ExtensionCard'

export default async function ExtensionsPage() {
  const t = await getTranslations('extensions')
  const tSettings = await getTranslations('settings_nav')
  const extensions = getAllExtensions()

  return (
    <div className="space-y-8">
      {/* Tillägg is reached from Kopplingar (V7 coverage). */}
      <PageHeader title={t('page_title')} parent={{ label: tSettings('connections'), href: '/settings/connections' }} />

      <section>
        <h2 className="text-sm text-muted-foreground mb-4">
          {t('sector_general_name')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 stagger-enter">
          {extensions.map(ext => (
            <ExtensionCard key={ext.slug} extension={ext} />
          ))}
        </div>
      </section>
    </div>
  )
}
