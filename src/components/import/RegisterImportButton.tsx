'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Lock, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { registerImportHref, type RegisterImportEntity } from '@/lib/import/register-import-link'

/**
 * "Importera" in a register list page's top bar (Kunder, Leverantörer,
 * Artiklar), beside the Exportera menu. Opens the CSV/Excel wizard on the
 * import page with this register already selected. Viewers see it locked,
 * like every other write action.
 */
export function RegisterImportButton({ entity }: { entity: RegisterImportEntity }) {
  const t = useTranslations('import')
  const { canWrite } = useCanWrite()

  if (!canWrite) {
    return (
      <Button variant="outline" size="sm" disabled title={t('register_import_viewer_tooltip')}>
        <Lock className="mr-2 h-4 w-4" />
        {t('register_import_button')}
      </Button>
    )
  }

  return (
    <Button asChild variant="outline" size="sm">
      <Link href={registerImportHref(entity)}>
        <Upload className="mr-2 h-4 w-4" />
        {t('register_import_button')}
      </Link>
    </Button>
  )
}
