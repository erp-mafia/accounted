import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getExtensionDefinition } from '@/lib/extensions/sectors'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import {
  extensionNameKey,
  extensionDescriptionKey,
  extensionLongDescriptionKey,
} from '@/lib/extensions/i18n'
import { getRequestAppName } from '@/lib/branding/request-brand'
import CategoryBadge from '@/components/extensions/CategoryBadge'
import { WORKSPACES } from '@/lib/extensions/_generated/workspace-map'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/page-header'

export default async function ExtensionDetailPage({
  params,
}: {
  params: Promise<{ sector: string; extension: string }>
}) {
  const { sector: sectorSlug, extension: extensionSlug } = await params

  const definition = getExtensionDefinition(sectorSlug, extensionSlug)
  if (!definition) notFound()

  const t = await getTranslations('extensions')
  // Some long descriptions carry the {appName} ICU parameter (WL-12 appName
  // sweep); passing it unconditionally is harmless for messages without it.
  const appName = await getRequestAppName()

  const nameKey = extensionNameKey(definition.slug)
  const descriptionKey = extensionDescriptionKey(definition.slug)
  const longDescriptionKey = extensionLongDescriptionKey(definition.slug)
  const extensionName = nameKey ? t(nameKey) : definition.name
  const extensionDescription = descriptionKey ? t(descriptionKey, { appName }) : definition.description
  const extensionLongDescription = longDescriptionKey ? t(longDescriptionKey, { appName }) : definition.longDescription

  const Icon = resolveIcon(definition.icon)

  const hasWorkspace = `${sectorSlug}/${extensionSlug}` in WORKSPACES

  const dataPatternLabels: Record<string, string> = {
    core: t('data_pattern_core'),
    manual: t('data_pattern_manual'),
    both: t('data_pattern_both'),
  }

  // What the extension reads, in the words the app uses for it, never the
  // database table names. A table without a word here is left out, and with
  // none the line is dropped.
  const coreTableLabels: Record<string, string> = {
    invoices: t('core_table_invoices'),
    deadlines: t('core_table_deadlines'),
    customers: t('core_table_customers'),
    company_settings: t('core_table_company_settings'),
    document_attachments: t('core_table_document_attachments'),
    suppliers: t('core_table_suppliers'),
    invoice_inbox_items: t('core_table_invoice_inbox_items'),
    company_members: t('core_table_company_members'),
  }
  const readsFrom = (definition.readsCoreTables ?? [])
    .map((table) => coreTableLabels[table])
    .filter((label): label is string => !!label)

  return (
    <div>
      <PageHeader
        title={extensionName}
        parent={{ label: t('breadcrumb'), href: '/extensions' }}
        action={
          hasWorkspace ? (
            <Button size="toolbar" asChild>
              <Link href={`/e/${sectorSlug}/${extensionSlug}`}>
                {t('open')}
              </Link>
            </Button>
          ) : undefined
        }
      />

      {/* Header */}
      <div className="flex items-start gap-4 mb-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-secondary flex-shrink-0">
          <Icon className="h-6 w-6 text-foreground" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{extensionDescription}</p>
          <div className="mt-2">
            <CategoryBadge category={definition.category} />
          </div>
        </div>
      </div>

      {/* Details */}
      <div className="space-y-6">
        <div>
          <h2 className="text-sm text-muted-foreground mb-2">{t('description_heading')}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {extensionLongDescription}
          </p>
        </div>

        <div>
          <h2 className="text-sm text-muted-foreground mb-2">{t('data_source_heading')}</h2>
          <p className="text-sm text-muted-foreground">
            {dataPatternLabels[definition.dataPattern]}
          </p>
          {readsFrom.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('reads_from', { tables: readsFrom.join(', ') })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
