/**
 * What a connection row on the bank page offers, rendered from the real
 * component with its menu entries inline. While the switch campaign is on,
 * the server refuses every Enable Banking renewal before the bank
 * (lib/bank-feed/switch-campaign.ts enableBankingClosedToNew), so no row
 * offers one: a consent that has run out or is about to offers the way on as
 * its main button (the switch, or the bank file import where the switch
 * cannot be made), and every other row offers the switch in its menu. While
 * renewals are open the rows offer the renewal as before.
 */
import { Fragment, createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BankConnection } from '@/types'
import type { SunsetPath } from '../lib/connection-state'

vi.mock('next/link', () => ({
  // prefetch is next/link's own prop, not an anchor attribute.
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) =>
    createElement('a', { href, ...rest }, children),
}))

// The member may write; the lock itself is not what this test is about.
vi.mock('@/components/ui/viewer-lock', () => ({ useViewerLock: () => ({ canWrite: true, lockedTitle: undefined }) }))

// A closed menu renders only its trigger; inline, every entry it would offer is in the markup.
vi.mock('@/components/ui/dropdown-menu', () => {
  type Props = { children?: ReactNode; asChild?: boolean }
  const inline = ({ children }: Props) => createElement(Fragment, null, children)
  return {
    DropdownMenu: inline,
    DropdownMenuTrigger: inline,
    DropdownMenuContent: inline,
    DropdownMenuLabel: inline,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({ children, asChild }: Props) =>
      asChild ? createElement(Fragment, null, children) : createElement('span', { role: 'menuitem' }, children),
  }
})

const { BankConnectionStatus } = await import('../components/BankConnectionStatus')
const { switchDeepLink, BANK_FILE_IMPORT_PATH } = await import('@/lib/bank-feed/switch-link')

const DAY_MS = 24 * 60 * 60 * 1000
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()

const connection = (overrides: Partial<BankConnection> = {}): BankConnection => ({
  id: 'conn-1',
  user_id: 'user-1',
  company_id: 'company-1',
  bank_name: 'Swedbank',
  provider: 'swedbank-se',
  session_id: 'session-1',
  authorization_id: null,
  accounts_data: [],
  status: 'active',
  psu_type: 'business',
  consent_expires: inDays(60),
  last_synced_at: inDays(0),
  error_message: null,
  initial_sync_completed_at: null,
  initial_sync_requested_from: null,
  initial_sync_returned_min_date: null,
  initial_sync_returned_max_date: null,
  initial_sync_lookback_days: null,
  created_at: inDays(-60),
  updated_at: inDays(-1),
  ...overrides,
})

const row = (conn: BankConnection, renewalClosed: SunsetPath | null, sunset: SunsetPath | null = null) =>
  renderToStaticMarkup(
    createElement(BankConnectionStatus, {
      connection: conn,
      onSync: () => undefined,
      onDisconnect: () => undefined,
      onReconnect: () => undefined,
      renewalClosed,
      sunset,
    }),
  )

const switchLinks = (html: string) => html.split(`href="${switchDeepLink('conn-1')}"`).length - 1
const importLinks = (html: string) => html.split(`href="${BANK_FILE_IMPORT_PATH}"`).length - 1

// A consent that needs renewing: run out, or running out in two days.
const needsRenewal: Array<[string, BankConnection]> = [
  ['expired', connection({ status: 'expired', consent_expires: inDays(-1), last_synced_at: inDays(-2) })],
  ['expiring', connection({ consent_expires: inDays(2) })],
]
// Every other row the menu's renewal used to be offered on.
const otherRows: Array<[string, BankConnection]> = [
  ['active', connection()],
  ['stale', connection({ last_synced_at: inDays(-10) })],
  ['failed', connection({ status: 'error' })],
]

describe('a connection row while renewals are closed', () => {
  it.each(needsRenewal)('offers the switch as the %s consent\'s main button, and no renewal anywhere', (_state, conn) => {
    const html = row(conn, 'switch')
    expect(switchLinks(html)).toBe(1)
    expect(html).toContain('Byt till ny koppling')
    expect(html).not.toContain('Förnya')
    expect(html).not.toContain('Företagskonto')
  })

  it.each(needsRenewal)('offers the bank file import for the %s consent where the switch cannot be made', (_state, conn) => {
    const html = row(conn, 'import')
    expect(html).toContain('Importera kontoutdrag')
    expect(importLinks(html)).toBeGreaterThan(0)
    expect(switchLinks(html)).toBe(0)
    expect(html).not.toContain('Förnya')
  })

  it.each(otherRows)('offers the %s row the switch in its menu, and no renewal', (_state, conn) => {
    const html = row(conn, 'switch')
    expect(switchLinks(html)).toBe(1)
    expect(html).not.toContain('Förnya')
    expect(html).not.toContain('Företagskonto')
  })

  it.each(otherRows)('offers the %s row neither a renewal nor a switch where the switch cannot be made', (_state, conn) => {
    const html = row(conn, 'import')
    expect(switchLinks(html)).toBe(0)
    expect(html).not.toContain('Förnya')
  })

  it('offers a row whose feed has ended the switch once, as its main button', () => {
    expect(switchLinks(row(connection(), 'switch', 'switch'))).toBe(1)
  })
})

describe('a connection row while renewals are open', () => {
  it.each(needsRenewal)('offers the renewal as the %s consent\'s main button', (_state, conn) => {
    const html = row(conn, null)
    expect(html).toContain('Förnya samtycke')
    expect(html).toContain('Företagskonto')
    expect(switchLinks(html)).toBe(0)
  })

  it.each(otherRows)('offers the %s row the renewal in its menu', (_state, conn) => {
    const html = row(conn, null)
    expect(html).toContain('Förnya samtycke')
    expect(switchLinks(html)).toBe(0)
  })
})
