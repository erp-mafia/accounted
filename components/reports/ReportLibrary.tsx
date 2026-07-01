'use client'

import { getLibrarySections } from '@/lib/reports/catalog'
import { ReportSectionList } from '@/components/reports/ReportSectionList'
import type { EntityType } from '@/types'

/**
 * The report library — the calm "Alla rapporter" index for /reports. Every
 * visible report grouped by accounting taxonomy, each section a single DataList.
 * One report = one row = one destination; no data preview, so the index stays a
 * fast lookup. Rendering is delegated to the shared ReportSectionList.
 */
export function ReportLibrary({
  entityType,
  hasEmployees,
  onOpen,
}: {
  entityType?: EntityType
  hasEmployees?: boolean
  onOpen: (slug: string) => void
}) {
  const sections = getLibrarySections(entityType, hasEmployees).map((s) => ({
    key: s.category,
    labelKey: s.labelKey,
    items: s.items,
  }))

  return <ReportSectionList sections={sections} onOpen={onOpen} />
}
