/**
 * Startsida: the page a person lands on in a company when nothing asked for
 * another one, after signing in (lib/company/landing-server.ts, also behind
 * MFA) and after switching company (POST /api/company/switch). An explicit
 * destination (a `next` or `returnTo`, a deep link, a switch made for a given
 * page) still goes first: the callers ask for the start page only when they
 * would have landed on '/'.
 *
 * Chosen per person and per company under Inställningar > Ditt konto, stored
 * in user_preferences.ui_state.start_page (company id -> start page id). No
 * choice is Att göra ('/'), the landing from before the choice existed.
 *
 * Pure data and functions, no server imports: the settings row, the sign-in
 * pages and the server all read it.
 */
import { isInvoicerPagePath, isInvoicerRole } from '@/lib/auth/invoicer-role'

/**
 * The pages a person can start on, each the page its area's menu button
 * opens (components/dashboard/nav-v3.ts), and the nav label it goes by.
 */
export const START_PAGES = [
  { id: 'todo', path: '/', labelKey: 'v2_todo' },
  { id: 'bookkeeping', path: '/bookkeeping', labelKey: 'bookkeeping' },
  { id: 'to_book', path: '/att-bokfora', labelKey: 'v3_to_book' },
  { id: 'supplier_invoices', path: '/supplier-invoices', labelKey: 'supplier_invoices' },
  { id: 'invoices', path: '/invoices', labelKey: 'invoices' },
  { id: 'reports', path: '/reports/resultatrapport', labelKey: 'reports' },
] as const

export type StartPage = (typeof START_PAGES)[number]
export type StartPageId = StartPage['id']
export type StartPagePath = StartPage['path']

export const START_PAGE_IDS = START_PAGES.map((page) => page.id) as [StartPageId, ...StartPageId[]]

/** Att göra: where a person lands without a choice, and wherever a choice cannot be used. */
export const DEFAULT_START_PAGE: StartPage = START_PAGES[0]

/** What decides whether a person can open a start page in the active company. */
export interface StartPageContext {
  /** The person's role in the company; null or undefined when it is not known. */
  role: string | null | undefined
  /** The company is in the booking screen's rollout (lib/env/booking-screen-switch.ts): the Att bokföra page. */
  bookingScreenEnabled: boolean
}

function isStartPageId(value: unknown): value is StartPageId {
  return typeof value === 'string' && (START_PAGE_IDS as readonly string[]).includes(value)
}

/**
 * Whether the person can open this start page in the company. Att göra
 * always: the dashboard sends the invoicing-only role on from there itself.
 * Every other page needs a known role that may open it (the invoicer only
 * its own pages, lib/auth/invoicer-role.ts) and, for Att bokföra, the
 * booking screen switched on for the company.
 */
export function startPageOpens(id: StartPageId, ctx: StartPageContext): boolean {
  if (id === DEFAULT_START_PAGE.id) return true
  if (!ctx.role) return false
  const page = START_PAGES.find((p) => p.id === id)
  if (!page) return false
  if (isInvoicerRole(ctx.role) && !isInvoicerPagePath(page.path)) return false
  if (id === 'to_book' && !ctx.bookingScreenEnabled) return false
  return true
}

/**
 * The start page in effect for the company: the person's stored choice when
 * they can open it there, else Att göra. `choices` is the stored map as read
 * (ui_state.start_page): anything that is not a known choice for this company
 * reads as no choice.
 */
export function startPageFor(
  choices: unknown,
  companyId: string | null | undefined,
  ctx: StartPageContext,
): StartPage {
  if (!companyId || !choices || typeof choices !== 'object' || Array.isArray(choices)) return DEFAULT_START_PAGE
  const choice = (choices as Record<string, unknown>)[companyId]
  if (!isStartPageId(choice) || !startPageOpens(choice, ctx)) return DEFAULT_START_PAGE
  return START_PAGES.find((page) => page.id === choice) ?? DEFAULT_START_PAGE
}

/** Whether a landing answer names a start page: the sign-in pages and the switch follow nothing else. */
export function isStartPagePath(value: unknown): value is StartPagePath {
  return typeof value === 'string' && START_PAGES.some((page) => page.path === value)
}

/** The stored map read defensively out of the jsonb bag: company id -> a known start page id. */
export function storedStartPages(value: unknown): Record<string, StartPageId> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const choices: Record<string, StartPageId> = {}
  for (const [companyId, id] of Object.entries(value as Record<string, unknown>)) {
    if (isStartPageId(id)) choices[companyId] = id
  }
  return choices
}
