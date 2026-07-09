import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getExtensionDefinition } from '@/lib/extensions/sectors'
import ExtensionWorkspaceLoader from '@/components/extensions/ExtensionWorkspaceLoader'
import { getActiveCompanyId } from '@/lib/company/context'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { requiredCapabilityForExtension } from '@/lib/entitlements/keys'
import { ExtensionUpsellState } from '@/components/extensions/ExtensionUpsellState'

export default async function ExtensionWorkspacePage({
  params,
}: {
  params: Promise<{ sector: string; slug: string }>
}) {
  const { sector, slug } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const definition = getExtensionDefinition(sector, slug)
  if (!definition) notFound()

  // Paywall: an extension whose entire value is a paid service (invoice-inbox →
  // AI field extraction) is blocked at the page, not just at its API routes, so
  // a non-payer never lands on a working-looking workspace. The sidebar item and
  // command palette hide the same way off the same map (lib/entitlements/keys).
  // Fail closed: no resolvable company or the capability absent, both block.
  const requiredCapability = requiredCapabilityForExtension(sector, slug)
  if (requiredCapability) {
    const companyId = await getActiveCompanyId(supabase, user.id)
    const allowed = companyId
      ? await hasCapability(supabase, companyId, requiredCapability)
      : false
    if (!allowed) {
      const t = await getTranslations('extensions')
      // Only plain strings cross into the client component here: passing a
      // resolved icon component would crash RSC serialization (500 page).
      return (
        <ExtensionUpsellState
          iconName={definition.icon}
          title={t('upsell_title', { name: definition.name })}
          description={t('upsell_description')}
          ctaLabel={t('upsell_cta')}
          ctaHref="/settings/billing"
        />
      )
    }
  }

  return (
    <ExtensionWorkspaceLoader
      sector={sector}
      slug={slug}
      definition={definition}
      userId={user.id}
    />
  )
}
