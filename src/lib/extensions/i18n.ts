// Translation key lookup for extension and sector slugs.
//
// Extension manifests ship Swedish-only names/descriptions in the data layer
// (lib/extensions/_generated/sector-definitions.ts and lib/extensions/sectors.ts).
// Translation happens at the render layer via these slug → key helpers.
//
// For known slugs, return the translation key under the `extensions` namespace.
// For unknown slugs, return null: callers fall back to the manifest values.

/**
 * Extensions whose name and descriptions are translated under the
 * `extensions` namespace as ext_<slug, dashes as underscores>_name,
 * _description and _long_description. Every enabled extension must be here
 * (lib/extensions/__tests__/i18n.test.ts), or an English UI shows its
 * Swedish manifest text.
 */
const TRANSLATED_EXTENSIONS = new Set([
  'enable-banking',
  'email',
  'arcim-migration',
  'tic',
  'mcp-server',
  'cloud-backup',
  'skatteverket',
  'invoice-inbox',
  'calendar',
  'document-extraction',
  'stripe',
  'whatsapp-inbox',
  'woocommerce',
  'shopify',
  'zettle',
  'mail',
])

function extensionKey(slug: string, field: 'name' | 'description' | 'long_description'): string | null {
  return TRANSLATED_EXTENSIONS.has(slug) ? `ext_${slug.replace(/-/g, '_')}_${field}` : null
}

export function extensionNameKey(slug: string): string | null {
  return extensionKey(slug, 'name')
}

export function extensionDescriptionKey(slug: string): string | null {
  return extensionKey(slug, 'description')
}

export function extensionLongDescriptionKey(slug: string): string | null {
  return extensionKey(slug, 'long_description')
}

export function sectorNameKey(slug: string): string | null {
  switch (slug) {
    case 'general':
      return 'sector_general_name'
    default:
      return null
  }
}

export function sectorDescriptionKey(slug: string): string | null {
  switch (slug) {
    case 'general':
      return 'sector_general_description'
    default:
      return null
  }
}
