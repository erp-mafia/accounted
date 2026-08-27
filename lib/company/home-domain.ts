/**
 * The home-domain rule (WL-01, locked): every company has exactly one home
 * domain: its byrå team's brand domain when the team has a brand, else the
 * canonical domain. A company is opened and worked in ONLY on its home
 * domain; everywhere else the UI shows a signpost, never the company.
 *
 * Explicitly a NAVIGATION rule, not a security boundary: access is governed
 * solely by company membership and RLS, unchanged. These helpers are pure so
 * the rule is unit-testable; the dashboard layout feeds them the host brand
 * (resolveBrandByHost) and the per-team brand map (resolveBrandsForTeams).
 */

export interface TeamBrandRef {
  domain: string
  appName: string
}

export interface ForeignCompanyRef {
  id: string
  name: string
  /** The host where this company is actually worked in. */
  domain: string
  /** Brand app name for the signpost copy; canonical app name when brandless. */
  appName: string
}

export interface HomeDomainPartition<T> {
  /** Companies homed on the current host: the only ones the switcher offers. */
  visible: T[]
  /** Companies homed elsewhere: shown as non-clickable "Hanteras via" entries. */
  foreign: Array<{ item: T; domain: string; appName: string }>
}

/**
 * Partition a user's companies by home domain for the current host.
 *
 * - On a brand host (hostBrandTeamId set): visible = companies owned by that
 *   brand's team; everything else is foreign (its own brand domain, or the
 *   canonical domain for brandless companies).
 * - On the canonical host (hostBrandTeamId null): visible = companies WITHOUT
 *   a brand; branded companies are foreign under their brand domain.
 *
 * A company whose team has no entry in brandByTeam is brandless and homed on
 * the canonical domain, so the canonical hot path (no brands anywhere) yields
 * visible = everything and foreign = [] : byte-identical behavior.
 */
export function partitionCompaniesByHomeDomain<T>(opts: {
  companies: T[]
  getTeamId: (company: T) => string | null
  brandByTeam: Map<string, TeamBrandRef>
  hostBrandTeamId: string | null
  canonicalDomain: string
  canonicalAppName: string
}): HomeDomainPartition<T> {
  const { companies, getTeamId, brandByTeam, hostBrandTeamId } = opts
  const visible: T[] = []
  const foreign: HomeDomainPartition<T>['foreign'] = []

  for (const company of companies) {
    const teamId = getTeamId(company)
    const brand = teamId ? brandByTeam.get(teamId) : undefined

    if (hostBrandTeamId !== null) {
      if (teamId === hostBrandTeamId) {
        visible.push(company)
      } else {
        foreign.push({
          item: company,
          domain: brand?.domain ?? opts.canonicalDomain,
          appName: brand?.appName ?? opts.canonicalAppName,
        })
      }
    } else if (!brand) {
      visible.push(company)
    } else {
      foreign.push({ item: company, domain: brand.domain, appName: brand.appName })
    }
  }

  return { visible, foreign }
}

/**
 * Whether the active company is homed on the current host (its brand domain
 * equals the host's brand domain; null equals null on canonical). When false
 * the layout renders the signpost instead of the company's dashboard.
 */
export function isCompanyHomedOnHost(opts: {
  companyTeamId: string | null
  brandByTeam: Map<string, TeamBrandRef>
  hostBrandTeamId: string | null
}): boolean {
  const brand = opts.companyTeamId ? opts.brandByTeam.get(opts.companyTeamId) : undefined
  if (opts.hostBrandTeamId === null) return !brand
  return opts.companyTeamId === opts.hostBrandTeamId
}

/**
 * Post-login landing (WL-14): byrå staff land in the cockpit on the byrå's
 * home domain: the brand domain when the team has a brand, else the canonical
 * domain (a byrå team without white label is a valid state, WL-01). Everyone
 * else keeps today's '/' byte-identically.
 */
export function resolveLandingPath(opts: {
  /** teams.id of the brand serving the current host, null on canonical. */
  hostBrandTeamId: string | null
  /** The user's byrå team memberships with brand presence. */
  byraTeams: Array<{ teamId: string; hasBrand: boolean }>
}): '/clients' | '/' {
  if (opts.hostBrandTeamId !== null) {
    return opts.byraTeams.some((t) => t.teamId === opts.hostBrandTeamId)
      ? '/clients'
      : '/'
  }
  // Canonical host: only a brandless byrå homes its cockpit here.
  return opts.byraTeams.some((t) => !t.hasBrand) ? '/clients' : '/'
}

/**
 * Href for the pinned "Tillbaka till klienter" link: the byrå cockpit lives
 * on the byrå's home domain (its brand domain when the team has a brand, else
 * the canonical domain, same rule as WL-14's resolveLandingPath). Relative
 * '/clients' when the current host IS that home; an absolute URL otherwise,
 * so a byrå member working a company homed on a different host (e.g. a
 * pre-byrå company on canonical) is sent to their white-label cockpit.
 *
 * Navigation rule only, like everything in this file: the hop lands on the
 * brand host's login when there is no session there (per-host sessions,
 * WL-01), and WL-14 then lands the user on /clients.
 */
export function resolveCockpitHref(opts: {
  /** teams.id of the user's byrå team. */
  byraTeamId: string
  brandByTeam: Map<string, TeamBrandRef>
  /** teams.id of the brand serving the current host, null on canonical. */
  hostBrandTeamId: string | null
  canonicalDomain: string
}): string {
  const brand = opts.brandByTeam.get(opts.byraTeamId)
  if (brand) {
    return opts.hostBrandTeamId === opts.byraTeamId
      ? '/clients'
      : `https://${brand.domain}/clients`
  }
  // Brandless byrå: the cockpit is homed on the canonical domain.
  return opts.hostBrandTeamId === null
    ? '/clients'
    : `https://${opts.canonicalDomain}/clients`
}
