import type { Extension } from '@/lib/extensions/types'
import { registerBrandingService } from '@/lib/branding/service'

// Register the whitelabel branding values immediately when this extension is loaded.
// Edit the values below to match your brand. Any field omitted falls back to the
// Accounted default (and to whatever you've set via env vars). See docs/WHITELABEL.md.
registerBrandingService({
  // appName: 'YourBrand',
  // appDescription: 'Bokföring & redovisning',
  // legalEntity: 'YourBrand AB',
  // supportEmail: 'support@yourbrand.se',
  // privacyEmail: 'privacy@yourbrand.se',
  // securityEmail: 'security@yourbrand.se',
  // appUrl: 'https://app.yourbrand.se',
  // logoPath: '/api/extensions/ext/_example-branding/assets/logo.svg',
  // faviconPath: '/api/extensions/ext/_example-branding/assets/favicon.ico',
  // appleTouchIconPath: '/api/extensions/ext/_example-branding/assets/apple-touch-icon-192.png',
  // pwaIconBasePath: '/api/extensions/ext/_example-branding/assets/icons',
  // themeColor: '#000000',
  // manifestThemeColor: '#000000',
  // manifestBackgroundColor: '#ffffff',
  // hiddenNavHrefs: ['/salary', '/salary/employees', '/customers'],
})

export const exampleBrandingExtension: Extension = {
  id: '_example-branding',
  name: 'Whitelabel branding (example)',
  version: '1.0.0',
}
