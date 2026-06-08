'use client'

import { Download, FileSpreadsheet, FileText } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ReportExportFormat } from '@/lib/reports/catalog'

export interface ReportExportItem {
  format: ReportExportFormat
  href: string
}

/**
 * The single "Exportera" affordance for a report. Replaces the scattered
 * per-format download buttons that used to float inside report card bodies.
 * `children` lets a report append a sibling action (e.g. the VAT review agent).
 */
export function ReportExportMenu({
  items,
  children,
}: {
  items?: ReportExportItem[]
  children?: React.ReactNode
}) {
  const t = useTranslations('reports')
  const hasItems = !!items && items.length > 0
  if (!hasItems && !children) return null

  return (
    <div className="flex items-center justify-end gap-2">
      {hasItems && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4 mr-2" />
              {t('export')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {items!.map((item) => (
              <DropdownMenuItem
                key={item.href}
                onSelect={() => window.open(item.href, '_blank')}
              >
                {item.format === 'pdf' ? (
                  <FileText className="h-4 w-4 mr-2" />
                ) : (
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                )}
                {item.format === 'pdf' ? t('download_pdf') : t('download_excel')}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {children}
    </div>
  )
}
