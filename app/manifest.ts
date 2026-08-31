import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { ensureInitialized } from '@/lib/init'
import { getBranding } from '@/lib/branding/service'
import { resolveBrandByHost } from '@/lib/branding/resolve'

// Guarantee branding extensions have registered before the manifest is built.
ensureInitialized()

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const b = getBranding()
  // Host-aware branding (WL-12 slice A3): a branded host installs a PWA with
  // the brand's name and color. Reading headers() makes this route dynamic;
  // unknown hosts fall through to the default values below, unchanged.
  const requestHeaders = await headers()
  const host = requestHeaders.get('host')
  const brand = host ? await resolveBrandByHost(host) : null
  const sizes = [72, 96, 128, 144, 152, 192, 384, 512]
  // Next.js's Icon type doesn't accept the space-separated "any maskable" purpose
  // that the original public/manifest.json used. Cast preserves the same JSON
  // output so PWA install prompts behave identically to before.
  const icons = sizes.map((size) => ({
    src: `${b.pwaIconBasePath}/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose: 'any maskable',
  })) as unknown as MetadataRoute.Manifest['icons']
  return {
    name: brand?.appName ?? b.appName,
    short_name: brand?.appName ?? b.appName,
    description: b.appDescription,
    start_url: '/',
    display: 'standalone',
    background_color: b.manifestBackgroundColor,
    theme_color: brand?.brandColor ?? b.manifestThemeColor,
    orientation: 'portrait-primary',
    icons,
    categories: ['business', 'finance', 'productivity'],
    lang: 'sv-SE',
  }
}
