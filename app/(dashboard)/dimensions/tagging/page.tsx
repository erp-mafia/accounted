import { PageHeader } from '@/components/ui/page-header'
import BulkTagWorkbench from '@/components/dimensions/BulkTagWorkbench'

/**
 * Bulk retro-tagging workbench (dimensions plan PR6 §3) — tag or retag
 * dimensions on already-posted verifikat lines through the audited
 * retag_line_dimensions path. Thin shell; the workbench is client-side.
 *
 * Hardcoded Swedish like the rest of the dimensions/verifikat surface
 * (.claude/rules/i18n.md — operates directly on posted vouchers).
 */
export default function DimensionTaggingPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Tagga historik" />
      <BulkTagWorkbench />
    </div>
  )
}
