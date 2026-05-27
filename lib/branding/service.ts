/**
 * Branding Service
 *
 * Provides whitelabel-friendly branding values (app name, support emails,
 * asset paths, theme colors) with three-tier resolution:
 *
 *   defaults  <  env vars  <  extension override
 *
 * If nothing is set, gnubok defaults are returned — production behaviour
 * is unchanged. A whitelabel sets env vars (NEXT_PUBLIC_BRANDING_* for
 * client-readable, BRANDING_* for server-only) or registers a branding
 * extension via registerBrandingService().
 *
 * See WHITELABEL.md for the full env var reference and fork checklist.
 */

export interface BrandingConfig {
  // Identity
  appName: string
  appDescription: string
  legalEntity: string

  // Contact
  supportEmail: string
  privacyEmail: string
  securityEmail: string

  // Address Supabase Auth sends verification / reset emails from. Used to build
  // the `from:` query on the "check your email" screen's Gmail deep link.
  // Must match the From in your Supabase Auth SMTP config.
  authEmailFrom: string

  // URLs
  appUrl: string

  // Asset paths
  logoPath: string
  faviconPath: string
  appleTouchIconPath: string
  pwaIconBasePath: string

  // Colors
  themeColor: string
  manifestThemeColor: string
  manifestBackgroundColor: string

  // Navigation
  hiddenNavHrefs: string[]
  /**
   * Sidebar density. `'standard'` renders the original full sidebar with
   * every nav group at equal weight. `'slim'` renders an AI-first layout:
   * four primary destinations (Översikt, Transaktioner, Fakturor, Anna)
   * are visible at full weight, every other group is collapsed and muted,
   * and Inställningar/Hjälp/Logga ut move into a profile dropdown.
   * Set per-brand; default `'standard'` so self-hosted is unchanged.
   */
  navDensity: 'standard' | 'slim'
}

const DEFAULT_BRANDING: BrandingConfig = {
  appName: 'Gnubok',
  appDescription: 'Ekonomihantering',
  legalEntity: 'Arcim',
  supportEmail: 'support@gnubok.se',
  privacyEmail: 'privacy@gnubok.se',
  securityEmail: 'security@arcim.io',
  authEmailFrom: 'noreply@gnubok.se',
  appUrl: process.env.NEXT_PUBLIC_APP_URL || 'https://app.gnubok.se',
  logoPath: '/gnubokiceon-removebg-preview.png',
  faviconPath: '/favicon.ico',
  appleTouchIconPath: '/icons/icon-192.png',
  pwaIconBasePath: '/icons',
  themeColor: '#304D83',
  manifestThemeColor: '#1a1a1a',
  manifestBackgroundColor: '#ffffff',
  hiddenNavHrefs: [],
  navDensity: 'standard',
}

let _override: Partial<BrandingConfig> = {}

export function registerBrandingService(partial: Partial<BrandingConfig>): void {
  _override = { ...partial }
}

export function getBranding(): BrandingConfig {
  return {
    ...DEFAULT_BRANDING,
    ...readEnvOverrides(),
    ..._override,
  }
}

function readEnvOverrides(): Partial<BrandingConfig> {
  const env = process.env
  const o: Partial<BrandingConfig> = {}
  if (env.NEXT_PUBLIC_BRANDING_APP_NAME) o.appName = env.NEXT_PUBLIC_BRANDING_APP_NAME
  if (env.NEXT_PUBLIC_BRANDING_APP_DESCRIPTION) o.appDescription = env.NEXT_PUBLIC_BRANDING_APP_DESCRIPTION
  if (env.BRANDING_LEGAL_ENTITY) o.legalEntity = env.BRANDING_LEGAL_ENTITY
  if (env.BRANDING_SUPPORT_EMAIL) o.supportEmail = env.BRANDING_SUPPORT_EMAIL
  if (env.BRANDING_PRIVACY_EMAIL) o.privacyEmail = env.BRANDING_PRIVACY_EMAIL
  if (env.BRANDING_SECURITY_EMAIL) o.securityEmail = env.BRANDING_SECURITY_EMAIL
  if (env.NEXT_PUBLIC_BRANDING_AUTH_EMAIL_FROM) o.authEmailFrom = env.NEXT_PUBLIC_BRANDING_AUTH_EMAIL_FROM
  if (env.NEXT_PUBLIC_APP_URL) o.appUrl = env.NEXT_PUBLIC_APP_URL
  if (env.NEXT_PUBLIC_BRANDING_LOGO_PATH) o.logoPath = env.NEXT_PUBLIC_BRANDING_LOGO_PATH
  if (env.NEXT_PUBLIC_BRANDING_FAVICON_PATH) o.faviconPath = env.NEXT_PUBLIC_BRANDING_FAVICON_PATH
  if (env.NEXT_PUBLIC_BRANDING_APPLE_ICON_PATH) o.appleTouchIconPath = env.NEXT_PUBLIC_BRANDING_APPLE_ICON_PATH
  if (env.NEXT_PUBLIC_BRANDING_PWA_ICON_BASE) o.pwaIconBasePath = env.NEXT_PUBLIC_BRANDING_PWA_ICON_BASE
  if (env.NEXT_PUBLIC_BRANDING_THEME_COLOR) o.themeColor = env.NEXT_PUBLIC_BRANDING_THEME_COLOR
  if (env.NEXT_PUBLIC_BRANDING_MANIFEST_THEME_COLOR) o.manifestThemeColor = env.NEXT_PUBLIC_BRANDING_MANIFEST_THEME_COLOR
  if (env.NEXT_PUBLIC_BRANDING_MANIFEST_BG_COLOR) o.manifestBackgroundColor = env.NEXT_PUBLIC_BRANDING_MANIFEST_BG_COLOR
  if (env.NEXT_PUBLIC_BRANDING_HIDDEN_NAV) {
    const hrefs = env.NEXT_PUBLIC_BRANDING_HIDDEN_NAV.split(',').map(s => s.trim()).filter(Boolean)
    if (hrefs.length > 0) o.hiddenNavHrefs = hrefs
  }
  if (env.NEXT_PUBLIC_BRANDING_NAV_DENSITY === 'slim' || env.NEXT_PUBLIC_BRANDING_NAV_DENSITY === 'standard') {
    o.navDensity = env.NEXT_PUBLIC_BRANDING_NAV_DENSITY
  }
  return o
}
