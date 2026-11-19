import type { ExtensionDefinition } from './types'
import { EXTENSION_DEFINITIONS } from './_generated/sector-definitions'
import { WORKSPACES } from './_generated/workspace-map'
import { requiredCapabilityForExtension } from '@/lib/entitlements/keys'
import type { CapabilityKey } from '@/lib/entitlements/keys'

// ============================================================
// Extension definitions
// ============================================================
//
// Definitions come from the generated file (controlled by
// extensions.config.json), grouped by the manifest's sector slug, which is
// also the first URL segment of /extensions/<sector>/<slug> and
// /e/<sector>/<slug>.
// ============================================================

export function getAllExtensions(): ExtensionDefinition[] {
  return Object.values(EXTENSION_DEFINITIONS).flat()
}

export function getExtensionDefinition(sectorSlug: string, extensionSlug: string): ExtensionDefinition | undefined {
  return getAllExtensions().find(e => e.sector === sectorSlug && e.slug === extensionSlug)
}

/**
 * Paid capability an extension requires, resolved by its registry id (== slug).
 * The API-route dispatcher keys off this so a paid extension is gated at the
 * request chokepoint, reusing the same EXTENSION_REQUIRED_CAPABILITY map that
 * hides its sidebar item and blocks its page (lib/entitlements/keys).
 */
export function requiredCapabilityForExtensionId(extensionId: string): CapabilityKey | undefined {
  const ext = getAllExtensions().find(e => e.slug === extensionId)
  return ext ? requiredCapabilityForExtension(ext.sector, ext.slug) : undefined
}

/** Extensions with a workspace and a quickAction href, for sidebar nav. */
export function getExtensionNavItems(): { href: string; label: string; icon: string }[] {
  return getAllExtensions()
    .filter(e => {
      const key = `${e.sector}/${e.slug}`
      return key in WORKSPACES && !!e.quickAction?.href
    })
    .sort((a, b) => (a.quickAction!.order ?? 0) - (b.quickAction!.order ?? 0))
    .map(e => ({
      href: e.quickAction!.href!,
      label: e.quickAction!.label,
      icon: e.quickAction!.icon,
    }))
}
