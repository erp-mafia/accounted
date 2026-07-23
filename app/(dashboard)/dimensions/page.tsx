import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import DimensionsManager from '@/components/dimensions/DimensionsManager'

/**
 * Kostnadsställen & projekt (dimension registry): a Redovisning-group
 * register peer to Kontoplan. Reference/configuration surface: manage the
 * dimension values (#OBJEKT) that voucher lines are tagged with. Reachable
 * only via the nav row when company_settings.dimensions_enabled is on, but
 * the page itself never gates: the toggle is UI visibility, not correctness
 * (dimensions plan §2).
 */
export default async function DimensionsPage() {
  const t = await getTranslations('nav')
  return (
    <div className="space-y-8">
      {/* Page header (concept scene 31): title + quiet Tagga historik.
          "Tagga historik" stays Swedish like the workbench it opens (PR6). */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('dimensions')}</h1>
        <Link href="/dimensions/tagging" className={QUIET_LINK_CLASS}>
          Tagga historik
        </Link>
      </div>
      <DimensionsManager />
    </div>
  )
}
