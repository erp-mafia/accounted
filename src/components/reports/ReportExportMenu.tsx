'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownTrayIcon,
  CodeBracketSquareIcon,
  DocumentTextIcon,
  TableCellsIcon,
} from '@/components/icons'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useExportDownload } from '@/lib/hooks/use-export-download'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * pdf/xlsx for reports; csv is additionally used by register exports; xml is the
 * Skatteverket eSKD momsdeklaration file.
 */
export type ExportMenuFormat = 'pdf' | 'xlsx' | 'csv' | 'xml'

export interface ReportExportItem {
  format: ExportMenuFormat
  href: string
}

/**
 * The focused report page leaves this slot at the right end of its top bar.
 * A menu mounted anywhere below it moves in there: Exportera is a page-level
 * action, and a report never spends a row of its own on the button.
 */
export const REPORT_TOOLBAR_SLOT_ID = 'report-toolbar-end'

/**
 * The single "Exportera" affordance for a report. Replaces the scattered
 * per-format download buttons that used to float inside report card bodies.
 * `children` lets a report append a sibling action (e.g. the VAT review agent).
 */
export function ReportExportMenu({
  items,
  children,
  size = 'toolbar',
  variant = 'outline',
}: {
  items?: ReportExportItem[]
  children?: React.ReactNode
  size?: 'default' | 'toolbar'
  /** Trigger style; the VAT Stegen page uses the primary pill. */
  variant?: 'outline' | 'default'
}) {
  const t = useTranslations('reports')
  const { pending, download } = useExportDownload()
  // Resolved after mount: the slot is a sibling rendered above, present
  // only on the focused report page (never on the standalone VAT page).
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setSlot(document.getElementById(REPORT_TOOLBAR_SLOT_ID))
  }, [])
  const hasItems = !!items && items.length > 0
  if (!hasItems && !children) return null

  const menu = (
    <div className="flex items-center justify-end gap-2">
      {hasItems && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant={variant} size={size} loading={pending}>
              {!pending && <ArrowDownTrayIcon className="h-4 w-4" />}
              {t('export')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {items!.map((item) => (
              <DropdownMenuItem
                key={item.href}
                onSelect={() => void download(item.href, `export.${item.format}`)}
              >
                {item.format === 'pdf' ? (
                  <DocumentTextIcon className="h-4 w-4 mr-2" />
                ) : item.format === 'csv' ? (
                  <TableCellsIcon className="h-4 w-4 mr-2" />
                ) : item.format === 'xml' ? (
                  <CodeBracketSquareIcon className="h-4 w-4 mr-2" />
                ) : (
                  <TableCellsIcon className="h-4 w-4 mr-2" />
                )}
                {item.format === 'pdf'
                  ? t('download_pdf')
                  : item.format === 'csv'
                    ? t('download_csv')
                    : item.format === 'xml'
                      ? t('download_xml')
                      : t('download_excel')}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {children}
    </div>
  )
  return slot ? createPortal(menu, slot) : menu
}
