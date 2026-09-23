// Translation key lookup for extension and sector slugs.
//
// Extension manifests ship Swedish-only names/descriptions in the data layer
// (lib/extensions/_generated/sector-definitions.ts and lib/extensions/sectors.ts).
// Translation happens at the render layer via these slug → key helpers.
//
// For known slugs, return the translation key under the `extensions` namespace.
// For unknown slugs, return null: callers fall back to the manifest values.

export function extensionNameKey(slug: string): string | null {
  switch (slug) {
    case 'enable-banking':
      return 'ext_enable_banking_name'
    case 'email':
      return 'ext_email_name'
    case 'arcim-migration':
      return 'ext_arcim_migration_name'
    case 'tic':
      return 'ext_tic_name'
    case 'mcp-server':
      return 'ext_mcp_server_name'
    case 'cloud-backup':
      return 'ext_cloud_backup_name'
    case 'skatteverket':
      return 'ext_skatteverket_name'
    case 'invoice-inbox':
      return 'ext_invoice_inbox_name'
    default:
      return null
  }
}

export function extensionDescriptionKey(slug: string): string | null {
  switch (slug) {
    case 'enable-banking':
      return 'ext_enable_banking_description'
    case 'email':
      return 'ext_email_description'
    case 'arcim-migration':
      return 'ext_arcim_migration_description'
    case 'tic':
      return 'ext_tic_description'
    case 'mcp-server':
      return 'ext_mcp_server_description'
    case 'cloud-backup':
      return 'ext_cloud_backup_description'
    case 'skatteverket':
      return 'ext_skatteverket_description'
    case 'invoice-inbox':
      return 'ext_invoice_inbox_description'
    default:
      return null
  }
}

export function extensionLongDescriptionKey(slug: string): string | null {
  switch (slug) {
    case 'enable-banking':
      return 'ext_enable_banking_long_description'
    case 'email':
      return 'ext_email_long_description'
    case 'arcim-migration':
      return 'ext_arcim_migration_long_description'
    case 'tic':
      return 'ext_tic_long_description'
    case 'mcp-server':
      return 'ext_mcp_server_long_description'
    case 'cloud-backup':
      return 'ext_cloud_backup_long_description'
    case 'skatteverket':
      return 'ext_skatteverket_long_description'
    case 'invoice-inbox':
      return 'ext_invoice_inbox_long_description'
    default:
      return null
  }
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
