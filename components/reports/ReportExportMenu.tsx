'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, FileCode, FileSpreadsheet, FileText, Table } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useShell } from '@/components/dashboard/ShellProvider'
import { Button } from '@/components/ui/button'
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
 * Shell v2: the focused report page renders one toolbar row and leaves this
 * slot at its right end. A menu mounted anywhere below it moves in there,
 * so a report never spends a row of its own on the Exportera button.
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
  size = 'sm',
  variant = 'outline',
}: {
  items?: ReportExportItem[]
  children?: React.ReactNode
  size?: 'default' | 'sm'
  /** Trigger style; the VAT Stegen page uses the primary pill. */
  variant?: 'outline' | 'default'
}) {
  const t = useTranslations('reports')
  const shell = useShell()
  // Resolved after mount: the slot is a sibling rendered above, present
  // only on the focused report page in v2 (never on the standalone VAT page).
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setSlot(shell === 'v2' ? document.getElementById(REPORT_TOOLBAR_SLOT_ID) : null)
  }, [shell])
  const hasItems = !!items && items.length > 0
  if (!hasItems && !children) return null

  const menu = (
    <div className="flex items-center justify-end gap-2">
      {hasItems && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant={variant} size={size}>
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
                ) : item.format === 'csv' ? (
                  <Table className="h-4 w-4 mr-2" />
                ) : item.format === 'xml' ? (
                  <FileCode className="h-4 w-4 mr-2" />
                ) : (
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
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
