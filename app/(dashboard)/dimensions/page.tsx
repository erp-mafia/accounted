import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import DimensionsManager from '@/components/dimensions/DimensionsManager'

/**
 * Kostnadsställen & projekt (dimension registry) — a Redovisning-group
 * register peer to Kontoplan. Reference/configuration surface: manage the
 * dimension values (#OBJEKT) that voucher lines are tagged with. Reachable
 * only via the nav row when company_settings.dimensions_enabled is on, but
 * the page itself never gates — the toggle is UI visibility, not correctness
 * (dimensions plan §2).
 */
export default async function DimensionsPage() {
  const t = await getTranslations('nav')
  return (
    <div className="space-y-8">
      <PageHeader title={t('dimensions')} />
      <DimensionsManager />
    </div>
  )
}
