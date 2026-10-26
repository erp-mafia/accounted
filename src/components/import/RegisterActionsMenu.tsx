'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  ArrowUpTrayIcon,
  EllipsisHorizontalIcon,
  LockClosedIcon,
  TableCellsIcon,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { registerImportHref, type RegisterImportEntity } from '@/lib/import/register-import-link'

/**
 * The ⋯ beside "Ny ..." in a register list page's top bar (Kunder,
 * Leverantörer, Artiklar): Importera opens the CSV/Excel wizard on the
 * import page with this register already selected, and the register exports
 * as Excel or CSV. Import and export are occasional, so they sit behind one
 * icon instead of two outline buttons beside the primary. Viewers see
 * Importera locked, like every other write action; export stays open.
 */
export function RegisterActionsMenu({ entity }: { entity: RegisterImportEntity }) {
  const t = useTranslations('import')
  const tCommon = useTranslations('common')
  const { canWrite } = useCanWrite()
  const exportHref = `/api/export/${entity}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={tCommon('more_options')} title={tCommon('more_options')}>
          <EllipsisHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canWrite ? (
          <DropdownMenuItem asChild>
            <Link href={registerImportHref(entity)}>
              <ArrowUpTrayIcon className="mr-2 h-4 w-4" />
              {t('register_import_button')}
            </Link>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled title={t('register_import_viewer_tooltip')}>
            <LockClosedIcon className="mr-2 h-4 w-4" />
            {t('register_import_button')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => window.open(exportHref, '_blank')}>
          <TableCellsIcon className="mr-2 h-4 w-4" />
          {t('register_export_xlsx')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.open(`${exportHref}?format=csv`, '_blank')}>
          <TableCellsIcon className="mr-2 h-4 w-4" />
          {t('register_export_csv')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
