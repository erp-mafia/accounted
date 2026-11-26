import type { SupabaseClient } from '@supabase/supabase-js'
import { TO_BOOK_RETURN_PARAM } from '@/lib/bookkeeping/to-book'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { extensionLockedInSandbox, requiredCapabilityForExtension } from '@/lib/entitlements/keys'
import { getExtensionDefinition } from '@/lib/extensions/sectors'
import { INKORG_FOCUS_QUERY, INKORG_HREF, INKORG_VIEW_QUERY, isInkorgV2Enabled } from './flag'

/**
 * Which page is a company's inbox: the new page (/inkorg) or the workspace
 * of the invoice-inbox extension (/e/general/invoice-inbox).
 *
 * One rule, asked by both routes on the server. The new page's route renders
 * when the answer is the new page and sends the request to the workspace
 * otherwise; the workspace's route sends the request to the new page when
 * the answer is the new page and renders otherwise. The answer does not
 * depend on which address was asked for, so a request is redirected at most
 * once: the route it arrives at gets the same answer and renders.
 */

/** The extension both pages belong to, as the workspace's address names it. */
export const INBOX_EXTENSION = { sector: 'general', slug: 'invoice-inbox' } as const

/** Why a company's inbox is the workspace and not the new page. */
export type NotNewInboxReason =
  /** No company, or a company outside INKORG_V2_COMPANY_IDS. */
  | 'outside_rollout'
  /** The installation has no invoice-inbox extension: neither page exists. */
  | 'no_extension'
  /** A sandbox company, where the extension is locked in the sandbox: the workspace shows its lock. */
  | 'sandbox_lock'
  /** The company does not hold the capability the extension needs: the workspace shows the paywall. */
  | 'no_capability'

/** What the rule reads. The two functions are asked only when everything before them holds. */
export interface InboxPageReads {
  /** The company is in the new page's rollout (isInkorgV2Enabled); never true without a company. */
  inRollout: boolean
  /** The installation has the invoice-inbox extension. */
  extensionExists: boolean
  /** The workspace would show its sandbox lock: the extension is locked in the sandbox (extensionLockedInSandbox) and the company is a sandbox. */
  sandboxLocked: () => boolean | Promise<boolean>
  /** The company holds the capability the extension needs; true when it needs none. */
  hasCapability: () => boolean | Promise<boolean>
}

/**
 * Why the company's inbox is not the new page, or null when it is. The
 * checks run in the order the new page's route makes them, and a later one
 * is read only when the ones before it passed: a company outside the
 * rollout costs no read.
 */
export async function whyNotNewInbox(reads: InboxPageReads): Promise<NotNewInboxReason | null> {
  if (!reads.inRollout) return 'outside_rollout'
  if (!reads.extensionExists) return 'no_extension'
  if (await reads.sandboxLocked()) return 'sandbox_lock'
  if (!(await reads.hasCapability())) return 'no_capability'
  return null
}

/** This company's inbox is the new page. */
export async function inboxIsNewPage(reads: InboxPageReads): Promise<boolean> {
  return (await whyNotNewInbox(reads)) === null
}

/**
 * The rule's reads for one company, the same for both routes. `isSandbox`
 * is the caller's read of the company's settings row, which the dashboard
 * makes once per request.
 */
export function companyInboxReads(
  supabase: SupabaseClient,
  companyId: string | null | undefined,
  isSandbox: () => Promise<boolean>,
): InboxPageReads {
  const required = requiredCapabilityForExtension(INBOX_EXTENSION.sector, INBOX_EXTENSION.slug)
  return {
    inRollout: isInkorgV2Enabled(companyId),
    extensionExists: getExtensionDefinition(INBOX_EXTENSION.sector, INBOX_EXTENSION.slug) !== undefined,
    sandboxLocked: async () => extensionLockedInSandbox(INBOX_EXTENSION.sector, INBOX_EXTENSION.slug) && (await isSandbox()),
    // An extension that needs no capability has no paywall.
    hasCapability: async () => required === undefined || (!!companyId && (await hasCapability(supabase, companyId, required))),
  }
}

/** Whether an extension workspace's address is the inbox workspace's. */
export function isInboxWorkspace(sector: string, slug: string): boolean {
  return sector === INBOX_EXTENSION.sector && slug === INBOX_EXTENSION.slug
}

/** A page's query as Next hands it to a route: a repeated parameter is a list. */
export type RouteQuery = Record<string, string | string[] | undefined>

/**
 * The new page's address for a request that asked for the workspace's.
 *
 * The workspace reads nothing from its address: it opens a document from
 * its own list, never from a parameter, so there is no parameter of its own
 * to turn into the new page's focus. What the new page reads is kept: the
 * view, the document to open (`fokus`) and, with a document, the list to
 * return to. A repeated parameter keeps its first value. Everything else is
 * dropped.
 */
export function inkorgHrefFromWorkspaceQuery(query: RouteQuery): string {
  const first = (name: string): string | null => {
    const value = query[name]
    return (Array.isArray(value) ? value[0] : value) || null
  }
  const kept = new URLSearchParams()
  const view = first(INKORG_VIEW_QUERY)
  if (view) kept.set(INKORG_VIEW_QUERY, view)
  const focus = first(INKORG_FOCUS_QUERY)
  if (focus) {
    kept.set(INKORG_FOCUS_QUERY, focus)
    // The new page reads the way back only beside a document to open.
    const back = first(TO_BOOK_RETURN_PARAM)
    if (back) kept.set(TO_BOOK_RETURN_PARAM, back)
  }
  const search = kept.toString()
  return search ? `${INKORG_HREF}?${search}` : INKORG_HREF
}
