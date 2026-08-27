/**
 * Brand resolution for white-label domains.
 *
 * Two resolvers against the same small `brands` table (WL-12):
 *
 *   - resolveBrandByHost(host):     what the screen shows (root layout reads
 *                                   the request host)
 *   - resolveBrandForCompany(id):   what outbound artifacts carry (email
 *                                   sender identity, mailed links) via
 *                                   companies.team_id -> brands.team_id,
 *                                   for cron/API paths that have no host
 *
 * Both use the cookieless service client and bypass RLS by design: anonymous
 * visitors on a brand domain need the brand before login. Results are cached
 * in-memory per key with a short TTL (~60s); ops-assisted onboarding
 * tolerates that staleness, so there is no invalidation infrastructure in v1.
 * Unknown hosts and brandless companies resolve to null, cached too, so the
 * canonical-domain hot path costs one lookup per TTL window; callers fall
 * back to getBranding() defaults (lib/branding/service.ts).
 */

import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { getContrastRatio } from '@/lib/invoices/contrast-check'

/** Camelcase mirror of a public.brands row. */
export interface Brand {
  id: string
  teamId: string
  domain: string
  appName: string
  logoUrl: string | null
  /** Square tab icon; the layout prefers it over logoUrl for rel="icon". */
  faviconUrl: string | null
  brandColor: string
  chromeColor: string | null
  fontKey: string
  supportEmail: string
  authEmailFrom: string | null
  senderDomain: string | null
  senderDomainStatus: 'unverified' | 'pending' | 'verified' | 'failed'
  resendDomainId: string | null
  /** 'invite_only' arms the signup gate (lib/auth/brand-signup-gate.ts). */
  signupMode: 'open' | 'invite_only'
}

interface BrandRow {
  id: string
  team_id: string
  domain: string
  app_name: string
  logo_url: string | null
  favicon_url: string | null
  brand_color: string
  chrome_color: string | null
  font_key: string
  support_email: string
  auth_email_from: string | null
  sender_domain: string | null
  sender_domain_status: string
  resend_domain_id: string | null
  signup_mode?: string | null
}

function mapRow(row: BrandRow): Brand {
  return {
    id: row.id,
    teamId: row.team_id,
    domain: row.domain,
    appName: row.app_name,
    logoUrl: row.logo_url,
    faviconUrl: row.favicon_url ?? null,
    brandColor: row.brand_color,
    chromeColor: row.chrome_color,
    fontKey: row.font_key,
    supportEmail: row.support_email,
    authEmailFrom: row.auth_email_from,
    senderDomain: row.sender_domain,
    senderDomainStatus: row.sender_domain_status as Brand['senderDomainStatus'],
    resendDomainId: row.resend_domain_id,
    // Anything but the explicit invite_only value reads as 'open' so the
    // additive guarantee holds even against a stale schema cache.
    signupMode: row.signup_mode === 'invite_only' ? 'invite_only' : 'open',
  }
}

// ============================================================
// In-memory TTL cache (module-level; no external deps)
// ============================================================

const CACHE_TTL_MS = 60_000

interface CacheEntry {
  value: Brand | null
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function readCache(key: string): CacheEntry | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry
}

function writeCache(key: string, value: Brand | null): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

/** Test hook: drop every cached resolution. */
export function clearBrandCache(): void {
  cache.clear()
}

// ============================================================
// Resolvers
// ============================================================

/**
 * Normalize a Host header value to the shape stored in brands.domain:
 * lowercase hostname, no port, no trailing dot.
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase()
  const colon = h.indexOf(':')
  if (colon !== -1) h = h.slice(0, colon)
  return h.replace(/\.+$/, '')
}

/**
 * Look up the brand serving `host`. Null for unknown hosts (the canonical
 * domain included): callers fall back to getBranding() defaults, which keeps
 * the additive guarantee (unknown host = default Accounted, bit for bit).
 */
export async function resolveBrandByHost(host: string): Promise<Brand | null> {
  const normalized = normalizeHost(host)
  if (!normalized) return null

  const key = `host:${normalized}`
  const hit = readCache(key)
  if (hit) return hit.value

  const supabase = createServiceClientNoCookies()
  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('domain', normalized)
    .maybeSingle()

  if (error) {
    // Transient failure: fall back to defaults without caching, so a live
    // brand is not masked for a whole TTL window by one failed query.
    return null
  }

  const brand = data ? mapRow(data as BrandRow) : null
  writeCache(key, brand)
  return brand
}

/**
 * Look up the brand a company's outbound artifacts should carry:
 * companies.team_id -> brands.team_id. Null when the company does not exist,
 * has no team, or its team has no brand.
 */
export async function resolveBrandForCompany(companyId: string): Promise<Brand | null> {
  if (!companyId) return null

  const key = `company:${companyId}`
  const hit = readCache(key)
  if (hit) return hit.value

  const supabase = createServiceClientNoCookies()
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('team_id')
    .eq('id', companyId)
    .maybeSingle()

  if (companyError) return null

  const teamId = (company as { team_id: string | null } | null)?.team_id ?? null
  if (!teamId) {
    writeCache(key, null)
    return null
  }

  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('team_id', teamId)
    .maybeSingle()

  if (error) return null

  const brand = data ? mapRow(data as BrandRow) : null
  writeCache(key, brand)
  return brand
}

/**
 * Look up the brand owned by a team directly (brands.team_id is unique).
 * For team-scoped artifacts that concern no single company, e.g. the byrå
 * team-invite mail. Null when the team has no brand; cached like the other
 * resolvers.
 */
export async function resolveBrandForTeam(teamId: string): Promise<Brand | null> {
  if (!teamId) return null

  const key = `team:${teamId}`
  const hit = readCache(key)
  if (hit) return hit.value

  const supabase = createServiceClientNoCookies()
  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('team_id', teamId)
    .maybeSingle()

  if (error) return null

  const brand = data ? mapRow(data as BrandRow) : null
  writeCache(key, brand)
  return brand
}

// ============================================================
// Chrome derivation (WL-02: config model A standard, C opt-in)
// ============================================================

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

// Deep chrome tone bounds (WL-02 round 2): keep the brand hue, clamp
// saturation to roughly 30-35% and lightness to roughly 15-17% so the
// frame/sidebar reads as a deep-branded tone in both light and dark mode.
const CHROME_SATURATION_MIN = 0.3
const CHROME_SATURATION_MAX = 0.35
const CHROME_LIGHTNESS_MIN = 0.15
const CHROME_LIGHTNESS_MAX = 0.17

// Below this saturation the hue carries no real information (HSL reports
// hue 0 for pure grays); boosting saturation would tint a neutral brand
// red-ish, so near-achromatic brand colors keep their neutrality.
const ACHROMATIC_SATURATION_THRESHOLD = 0.05

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = HEX_COLOR_RE.exec(hex.trim())
  if (!m) throw new Error(`Invalid hex color: ${hex}`)
  const value = m[0].slice(1)
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min

  let h = 0
  let s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }

  return { h, s, l }
}

/** HSL (h in degrees, s/l as 0-1 fractions) to `#rrggbb`. Exported for the
 * brand style block's dark-mode contrast check (lib/branding/brand-style.ts). */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))

  let r1 = 0
  let g1 = 0
  let b1 = 0
  if (hp < 1) [r1, g1] = [c, x]
  else if (hp < 2) [r1, g1] = [x, c]
  else if (hp < 3) [g1, b1] = [c, x]
  else if (hp < 4) [g1, b1] = [x, c]
  else if (hp < 5) [r1, b1] = [x, c]
  else [r1, b1] = [c, x]

  const m = l - c / 2
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`
}

/**
 * Derive the deep chrome tone from the brand color: same hue, saturation
 * clamped to [30%, 35%], lightness clamped to [15%, 17%]. Deterministic.
 * Near-achromatic inputs stay achromatic (a gray brand gets a neutral dark
 * gray chrome, not a red tint).
 */
export function deriveChromeColor(brandColorHex: string): string {
  const { h, s, l } = hexToHsl(brandColorHex)
  const chromeS =
    s < ACHROMATIC_SATURATION_THRESHOLD
      ? s
      : clamp(s, CHROME_SATURATION_MIN, CHROME_SATURATION_MAX)
  const chromeL = clamp(l, CHROME_LIGHTNESS_MIN, CHROME_LIGHTNESS_MAX)
  return hslToHex(h, chromeS, chromeL)
}

/**
 * The chrome color a brand actually renders with: the explicit ops override
 * when set, else the tone derived from the brand color.
 */
export function getEffectiveChrome(brand: Pick<Brand, 'brandColor' | 'chromeColor'>): string {
  return brand.chromeColor ?? deriveChromeColor(brand.brandColor)
}

// ============================================================
// Contrast guardrail (WL-02: reuse the invoice-branding check)
// ============================================================

/**
 * Whether white text on the brand color clears WCAG 2.2 AA for normal text
 * (4.5:1), i.e. the color is usable as a primary button background. Reuses
 * the invoice-branding contrast math (lib/invoices/contrast-check.ts).
 * Invalid hex input returns false rather than throwing: the gate rejects,
 * it never crashes onboarding.
 */
export function isBrandColorAccessible(hex: string): boolean {
  if (!HEX_COLOR_RE.test(hex.trim())) return false
  return getContrastRatio('#ffffff', hex.trim()) >= 4.5
}
