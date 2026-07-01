'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import type { ExtensionCategory } from '@/lib/extensions/types'

const CATEGORY_LABEL_KEY: Record<ExtensionCategory, string> = {
  accounting: 'category_accounting',
  reports: 'category_reports',
  import: 'category_import',
  operations: 'category_operations',
}

export default function CategoryBadge({ category }: { category: ExtensionCategory }) {
  const t = useTranslations('extensions')
  return (
    <Badge variant="outline" className="text-[10px] font-medium">
      {t(CATEGORY_LABEL_KEY[category])}
    </Badge>
  )
}
