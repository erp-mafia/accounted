import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const ENV_KEYS = [
  'NEXT_PUBLIC_BRANDING_APP_NAME',
  'NEXT_PUBLIC_BRANDING_APP_DESCRIPTION',
  'BRANDING_LEGAL_ENTITY',
  'BRANDING_SUPPORT_EMAIL',
  'BRANDING_PRIVACY_EMAIL',
  'BRANDING_SECURITY_EMAIL',
  'NEXT_PUBLIC_BRANDING_AUTH_EMAIL_FROM',
  'NEXT_PUBLIC_BRANDING_LOGO_PATH',
  'NEXT_PUBLIC_BRANDING_FAVICON_PATH',
  'NEXT_PUBLIC_BRANDING_APPLE_ICON_PATH',
  'NEXT_PUBLIC_BRANDING_PWA_ICON_BASE',
  'NEXT_PUBLIC_BRANDING_THEME_COLOR',
  'NEXT_PUBLIC_BRANDING_MANIFEST_THEME_COLOR',
  'NEXT_PUBLIC_BRANDING_MANIFEST_BG_COLOR',
  'NEXT_PUBLIC_BRANDING_HIDDEN_NAV',
  'NEXT_PUBLIC_BRANDING_NAV_DENSITY',
] as const

describe('branding service', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    const { registerBrandingService } = await import('../service')
    registerBrandingService({})
  })

  it('returns gnubok defaults when nothing is overridden', async () => {
    const { getBranding } = await import('../service')
    const b = getBranding()
    expect(b.appName).toBe('Gnubok')
    expect(b.appDescription).toBe('Ekonomihantering')
    expect(b.legalEntity).toBe('Arcim')
    expect(b.supportEmail).toBe('support@gnubok.se')
    expect(b.privacyEmail).toBe('privacy@gnubok.se')
    expect(b.securityEmail).toBe('security@arcim.io')
    expect(b.authEmailFrom).toBe('noreply@gnubok.se')
    expect(b.logoPath).toBe('/gnubokiceon-removebg-preview.png')
    expect(b.faviconPath).toBe('/favicon.ico')
    expect(b.appleTouchIconPath).toBe('/icons/icon-192.png')
    expect(b.pwaIconBasePath).toBe('/icons')
    expect(b.themeColor).toBe('#304D83')
    expect(b.manifestThemeColor).toBe('#1a1a1a')
    expect(b.manifestBackgroundColor).toBe('#ffffff')
    expect(b.hiddenNavHrefs).toEqual([])
    expect(b.navDensity).toBe('standard')
  })

  it('accepts NEXT_PUBLIC_BRANDING_NAV_DENSITY=slim', async () => {
    process.env.NEXT_PUBLIC_BRANDING_NAV_DENSITY = 'slim'
    const { getBranding } = await import('../service')
    expect(getBranding().navDensity).toBe('slim')
  })

  it('ignores invalid NEXT_PUBLIC_BRANDING_NAV_DENSITY values', async () => {
    process.env.NEXT_PUBLIC_BRANDING_NAV_DENSITY = 'compact'
    const { getBranding } = await import('../service')
    expect(getBranding().navDensity).toBe('standard')
  })

  it('extension override can set navDensity', async () => {
    const { getBranding, registerBrandingService } = await import('../service')
    registerBrandingService({ navDensity: 'slim' })
    expect(getBranding().navDensity).toBe('slim')
  })

  it('parses NEXT_PUBLIC_BRANDING_HIDDEN_NAV as comma-separated hrefs', async () => {
    process.env.NEXT_PUBLIC_BRANDING_HIDDEN_NAV = '/salary,/salary/employees,/customers'
    const { getBranding } = await import('../service')
    expect(getBranding().hiddenNavHrefs).toEqual(['/salary', '/salary/employees', '/customers'])
  })

  it('trims whitespace and drops empty entries in hidden nav list', async () => {
    process.env.NEXT_PUBLIC_BRANDING_HIDDEN_NAV = ' /salary , ,/customers, '
    const { getBranding } = await import('../service')
    expect(getBranding().hiddenNavHrefs).toEqual(['/salary', '/customers'])
  })

  it('empty NEXT_PUBLIC_BRANDING_HIDDEN_NAV keeps default empty list', async () => {
    process.env.NEXT_PUBLIC_BRANDING_HIDDEN_NAV = ''
    const { getBranding } = await import('../service')
    expect(getBranding().hiddenNavHrefs).toEqual([])
  })

  it('extension override replaces hiddenNavHrefs', async () => {
    process.env.NEXT_PUBLIC_BRANDING_HIDDEN_NAV = '/salary'
    const { getBranding, registerBrandingService } = await import('../service')
    registerBrandingService({ hiddenNavHrefs: ['/customers', '/suppliers'] })
    expect(getBranding().hiddenNavHrefs).toEqual(['/customers', '/suppliers'])
  })

  it('env vars override defaults', async () => {
    process.env.NEXT_PUBLIC_BRANDING_APP_NAME = 'Holdio'
    process.env.BRANDING_SUPPORT_EMAIL = 'hello@holdio.se'
    process.env.NEXT_PUBLIC_BRANDING_LOGO_PATH = '/holdio-logo.svg'
    process.env.NEXT_PUBLIC_BRANDING_AUTH_EMAIL_FROM = 'noreply@holdio.se'
    const { getBranding } = await import('../service')
    const b = getBranding()
    expect(b.appName).toBe('Holdio')
    expect(b.supportEmail).toBe('hello@holdio.se')
    expect(b.logoPath).toBe('/holdio-logo.svg')
    expect(b.authEmailFrom).toBe('noreply@holdio.se')
    expect(b.appDescription).toBe('Ekonomihantering')
  })

  it('extension override beats env vars', async () => {
    process.env.NEXT_PUBLIC_BRANDING_APP_NAME = 'EnvName'
    const { getBranding, registerBrandingService } = await import('../service')
    registerBrandingService({ appName: 'ExtensionName' })
    expect(getBranding().appName).toBe('ExtensionName')
  })

  it('extension partial override leaves untouched fields at default', async () => {
    const { getBranding, registerBrandingService } = await import('../service')
    registerBrandingService({ appName: 'Holdio' })
    const b = getBranding()
    expect(b.appName).toBe('Holdio')
    expect(b.legalEntity).toBe('Arcim')
    expect(b.supportEmail).toBe('support@gnubok.se')
  })

  it('empty string env var does not override', async () => {
    process.env.NEXT_PUBLIC_BRANDING_APP_NAME = ''
    const { getBranding } = await import('../service')
    expect(getBranding().appName).toBe('Gnubok')
  })

  it('clearing extension override returns to env/default resolution', async () => {
    const { getBranding, registerBrandingService } = await import('../service')
    registerBrandingService({ appName: 'Holdio' })
    expect(getBranding().appName).toBe('Holdio')
    registerBrandingService({})
    expect(getBranding().appName).toBe('Gnubok')
  })
})
