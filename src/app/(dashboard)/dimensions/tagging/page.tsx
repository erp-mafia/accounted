import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import BulkTagWorkbench from '@/components/dimensions/BulkTagWorkbench'

/**
 * Bulk retro-tagging workbench (dimensions plan PR6 §3): tag or retag
 * dimensions on already-posted verifikat lines through the audited
 * retag_line_dimensions path. Thin shell; the workbench is client-side.
 */
export default async function DimensionTaggingPage() {
  const t = await getTranslations('dimensions')
  return (
    <div className="space-y-8">
      <PageHeader title={t('tag_history')} />
      <BulkTagWorkbench />
    </div>
  )
}
