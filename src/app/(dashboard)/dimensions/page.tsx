import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import DimensionsManager from '@/components/dimensions/DimensionsManager'

/**
 * Dimensioner (the dimension registry): a Redovisning-group register peer
 * to Kontoplan. Reference/configuration surface: manage the dimensions
 * (#DIM) and the values (#OBJEKT) that voucher lines are tagged with.
 * Reachable only via the nav row when company_settings.dimensions_enabled
 * is on, but the page itself never gates: the toggle is UI visibility, not
 * correctness (dimensions plan §2).
 */
export default async function DimensionsPage() {
  const t = await getTranslations('nav')
  const tDimensions = await getTranslations('dimensions')
  return (
    <div className="space-y-8">
      {/* Page header (concept scene 31): title + a quiet link to the
          retro-tagging workbench. */}
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="page-header-title font-display text-2xl leading-8 tracking-tight">{t('dimensions')}</h1>
        <Link href="/dimensions/tagging" className={QUIET_LINK_CLASS}>
          {tDimensions('tag_history')}
        </Link>
      </div>
      <DimensionsManager />
    </div>
  )
}
