import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getExtensionDefinition } from '@/lib/extensions/sectors'
import ExtensionWorkspaceLoader from '@/components/extensions/ExtensionWorkspaceLoader'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { requiredCapabilityForExtension } from '@/lib/entitlements/keys'
import { ExtensionUpsellState } from '@/components/extensions/ExtensionUpsellState'
import { ExtensionSandboxLockState } from '@/components/extensions/ExtensionSandboxLockState'
import { extensionDescriptionKey, extensionNameKey } from '@/lib/extensions/i18n'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardSettings,
} from '../../../request-context'

export default async function ExtensionWorkspacePage({
  params,
}: {
  params: Promise<{ sector: string; slug: string }>
}) {
  const { sector, slug } = await params
  const [{ supabase, user }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])

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
    // Sandbox first, and before the capability check: a demo company holds the
    // 30-day trial grant every new company gets, so the paywall waves it
    // through onto a workspace whose external services the sandbox blocks
    // (lib/sandbox/guard.ts). An anonymous user also has no billing to
    // upgrade, so the billing upsell below would be the wrong exit.
    const settings = await getDashboardSettings()
    if (settings.data?.is_sandbox === true) {
      const t = await getTranslations('extensions')
      // The manifest ships Swedish-only name/description; the slug maps to a
      // translated pair at the render layer (lib/extensions/i18n), same as the
      // sidebar. Fall back to the manifest for a slug with no mapping yet.
      const nameKey = extensionNameKey(slug)
      const descriptionKey = extensionDescriptionKey(slug)
      return (
        <ExtensionSandboxLockState
          iconName={definition.icon}
          title={t('sandbox_locked_title', { name: nameKey ? t(nameKey) : definition.name })}
          description={descriptionKey ? t(descriptionKey) : definition.description}
          note={t('sandbox_locked_note')}
          ctaLabel={t('sandbox_locked_cta')}
        />
      )
    }

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
