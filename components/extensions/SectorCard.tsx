import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Card, CardContent } from '@/components/ui/card'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { sectorNameKey, sectorDescriptionKey } from '@/lib/extensions/i18n'
import type { Sector } from '@/lib/extensions/types'

export default async function SectorCard({ sector }: { sector: Sector }) {
  const t = await getTranslations('extensions')

  const nameKey = sectorNameKey(sector.slug)
  const descriptionKey = sectorDescriptionKey(sector.slug)
  const name = nameKey ? t(nameKey) : sector.name
  const description = descriptionKey ? t(descriptionKey) : sector.description

  const Icon = resolveIcon(sector.icon)

  return (
    <Link href={`/extensions/${sector.slug}`} className="h-full">
      <Card className="group hover:border-primary/30 transition-colors cursor-pointer h-full">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-medium group-hover:text-primary transition-colors">
                {name}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{description}</p>
              <p className="text-xs text-muted-foreground mt-1.5">
                {t('extension_count', { count: sector.extensions.length })}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
