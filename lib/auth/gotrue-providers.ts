/**
 * Fetch available auth providers and capabilities from Supabase GoTrue.
 *
 * Calls two endpoints:
 * 1. /auth/v1/settings (anon key) - returns built-in providers and signup config
 * 2. auth.admin.customProviders.listProviders() (service_role key) - custom OIDC/OAuth providers
 *
 * Both are merged into a single provider list. If the service_role key is
 * unavailable, only built-in providers are returned (custom providers are skipped).
 */

import { createServiceClientNoCookies } from '@/lib/auth/api-keys'

export type ExternalProvider =
  | 'apple'
  | 'azure'
  | 'bitbucket'
  | 'discord'
  | 'facebook'
  | 'figma'
  | 'fly'
  | 'github'
  | 'gitlab'
  | 'google'
  | 'kakao'
  | 'keycloak'
  | 'linkedin'
  | 'linkedin_oidc'
  | 'notion'
  | 'slack'
  | 'slack_oidc'
  | 'snapchat'
  | 'spotify'
  | 'twitch'
  | 'twitter'
  | 'workos'
  | 'zoom'
  | (string & {})

export interface GoTrueSettingsResponse {
  external: Record<string, boolean>
  disable_signup: boolean
  mailer_autoconfirm: boolean
  phone_autoconfirm: boolean
  sms_provider: string
  saml_enabled: boolean
  passkeys_enabled: boolean
}

/**
 * Display metadata for known OAuth providers.
 * Unknown providers (custom OIDC) get a generic SSO label.
 */
const PROVIDER_META: Record<
  string,
  { label: string }
> = {
  apple: { label: 'Apple' },
  azure: { label: 'Microsoft' },
  bitbucket: { label: 'Bitbucket' },
  discord: { label: 'Discord' },
  facebook: { label: 'Facebook' },
  figma: { label: 'Figma' },
  fly: { label: 'Fly' },
  github: { label: 'GitHub' },
  gitlab: { label: 'GitLab' },
  google: { label: 'Google' },
  kakao: { label: 'Kakao' },
  keycloak: { label: 'Keycloak' },
  linkedin: { label: 'LinkedIn' },
  linkedin_oidc: { label: 'LinkedIn' },
  notion: { label: 'Notion' },
  slack: { label: 'Slack' },
  slack_oidc: { label: 'Slack' },
  snapchat: { label: 'Snapchat' },
  spotify: { label: 'Spotify' },
  twitch: { label: 'Twitch' },
  twitter: { label: 'X / Twitter' },
  workos: { label: 'WorkOS' },
  zoom: { label: 'Zoom' },
}

export interface ResolvedProvider {
  /** Provider id passed to supabase.auth.signInWithOAuth({ provider }) */
  id: string
  /** Human-readable display name */
  label: string
  /** True for custom OIDC providers not in the built-in list */
  isCustom: boolean
}

export interface GoTrueAuthSettings {
  /** Enabled OAuth/OIDC providers for button rendering */
  providers: ResolvedProvider[]
  /** Whether email+password login is available (email provider enabled) */
  passwordLoginEnabled: boolean
  /** Whether self-service registration is allowed (disable_signup = false) */
  registrationEnabled: boolean
  /** Whether SAML SSO is enabled */
  samlEnabled: boolean
}

/**
 * Providers that are handled by dedicated UI components and should not
 * appear in the generic OAuth provider list.
 */
const EXCLUDED_PROVIDERS = new Set(['phone'])

/**
 * Fetch auth settings from GoTrue.
 *
 * Returns the list of enabled OAuth/OIDC providers for button rendering,
 * plus whether email+password login and registration are available.
 * Falls back to a safe default (no providers, password login enabled)
 * on network errors so the login page still renders.
 */
export async function fetchAuthSettings(): Promise<GoTrueAuthSettings> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !anonKey) {
    return { providers: [], passwordLoginEnabled: true, registrationEnabled: true, samlEnabled: false }
  }

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: anonKey },
      next: { revalidate: 60 }, // cache for 1 minute
      signal: AbortSignal.timeout(3000),
    })

    if (!res.ok) {
      return { providers: [], passwordLoginEnabled: true, registrationEnabled: true, samlEnabled: false }
    }

    const data: GoTrueSettingsResponse = await res.json()

    const providers = Object.entries(data.external)
      .filter(([name, enabled]) => enabled && !EXCLUDED_PROVIDERS.has(name) && name !== 'email')
      .map(([name]) => ({
        id: name,
        label: PROVIDER_META[name]?.label ?? name,
        isCustom: !(name in PROVIDER_META),
      }))

    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const serviceClient = createServiceClientNoCookies()
        const { data: customData } = await serviceClient.auth.admin.customProviders.listProviders()
        for (const cp of customData?.providers ?? []) {
          if (cp.enabled && cp.identifier) {
            providers.push({
              id: cp.identifier,
              label: PROVIDER_META[cp.identifier]?.label ?? cp.name ?? cp.identifier,
              isCustom: !(cp.identifier in PROVIDER_META),
            })
          }
        }
      } catch {
        // Custom providers are best-effort; don't break login if the admin endpoint is unreachable.
      }
    }

    return {
      providers,
      passwordLoginEnabled: data.external.email === true,
      registrationEnabled: !data.disable_signup,
      samlEnabled: data.saml_enabled,
    }
  } catch {
    return { providers: [], passwordLoginEnabled: true, registrationEnabled: true, samlEnabled: false }
  }
}
