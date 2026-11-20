/**
 * Who gets the one-time Discord invite card above the sidebar's user menu
 * (components/community/DiscordInviteCard). Server-side, from the dashboard
 * layout, so a dismissed or ineligible user never mounts the card and nothing
 * flashes. The card itself also waits until the sidebar has room for it.
 *
 * - Once per user: dismissing or joining stores
 *   user_preferences.ui_state.discord_invite_dismissed_at, on every device.
 * - From the first visit: someone who tries the app once and never returns
 *   would never see an invite that waited for a later day, and a new user has
 *   the most questions. The card lives in the main company shell only, so it
 *   stays out of onboarding.
 * - Only on Accounted's own hosted app: sandbox and anonymous demo sessions,
 *   white-label brand hosts and Docker self-hosts are not Accounted's
 *   community to invite into.
 */

export interface DiscordInviteInputs {
  /** ui_state.discord_invite_dismissed_at: set once the card was closed or used. */
  dismissedAt: string | null | undefined
  isSandbox: boolean
  isAnonymous: boolean | null | undefined
  /** The request came in on a partner's brand domain. */
  onBrandHost: boolean
  selfHosted: boolean
}

export function shouldOfferDiscordInvite(input: DiscordInviteInputs): boolean {
  if (input.dismissedAt) return false
  return !(input.isSandbox || input.isAnonymous || input.onBrandHost || input.selfHosted)
}
