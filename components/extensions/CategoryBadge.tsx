'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ExtensionCategory } from '@/lib/extensions/types'

const CATEGORY_CONFIG: Record<ExtensionCategory, { labelKey: string; className: string }> = {
  accounting: { labelKey: 'category_accounting', className: 'bg-destructive/10 text-destructive border-destructive/30' },
  reports: { labelKey: 'category_reports', className: 'bg-primary/10 text-primary border-primary/30' },
  import: { labelKey: 'category_import', className: 'bg-success/10 text-success border-success/30' },
  operations: { labelKey: 'category_operations', className: 'bg-muted text-muted-foreground border-border' },
}

export default function CategoryBadge({ category }: { category: ExtensionCategory }) {
  const t = useTranslations('extensions')
  const config = CATEGORY_CONFIG[category]
  return (
    <Badge variant="outline" className={cn('text-[10px] font-medium', config.className)}>
      {t(config.labelKey)}
    </Badge>
  )
}
