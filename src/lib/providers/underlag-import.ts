/**
 * Providers whose underlag (the files behind each verifikat) Accounted imports
 * from the provider's API: Fortnox archive files and Bokio uploads.
 *
 * The one definition for both sides: the migration UI offers the import only
 * for these providers, and the import itself is a no-op for any other. Keeping
 * it in core lets the extension and the UI share it (core must not import from
 * @/extensions/, but extensions may import from core).
 */
export const UNDERLAG_IMPORT_PROVIDERS = ['fortnox', 'bokio'] as const

export type UnderlagImportProvider = (typeof UNDERLAG_IMPORT_PROVIDERS)[number]

export function supportsUnderlagImport(
  provider: string | null | undefined,
): provider is UnderlagImportProvider {
  return (UNDERLAG_IMPORT_PROVIDERS as readonly string[]).includes(provider ?? '')
}
