import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import DimensionsManager from '@/components/dimensions/DimensionsManager'

/**
 * Kostnadsställen & projekt (dimension registry): a Redovisning-group
 * register peer to Kontoplan. Reference/configuration surface: manage the
 * dimension values (#OBJEKT) that voucher lines are tagged with. Reachable
 * only via the nav row when company_settings.dimensions_enabled is on, but
 * the page itself never gates: the toggle is UI visibility, not correctness
 * (dimensions plan §2).
 */
export default async function DimensionsPage() {
  const t = await getTranslations('nav')
  return (
    <div className="space-y-8">
      {/* "Tagga historik" stays Swedish like the workbench it opens (PR6). */}
      <PageHeader
        title={t('dimensions')}
        action={
          <Button variant="outline" asChild>
            <Link href="/dimensions/tagging">
              <History className="mr-2 h-4 w-4" />
              Tagga historik
            </Link>
          </Button>
        }
      />
      <DimensionsManager />
    </div>
  )
}
