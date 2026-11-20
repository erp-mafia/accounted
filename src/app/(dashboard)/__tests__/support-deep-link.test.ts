/**
 * crm#1393: the "we have answered, log in" mail links to /?support=1, which
 * SupportDialogHost turns into the open support dialog. The host was mounted
 * only in the no-company shell, so for everyone with a company the link
 * opened nothing and the answer looked gone. Once mounted, the dialog opened
 * with the page, before PostHog Support had loaded, and showed the empty mail
 * form instead of the thread. Components are not rendered in this suite
 * (vitest runs in `node`), so the wiring is pinned on the source; the wait
 * itself is tested in lib/support/__tests__/conversations.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const layout = fs.readFileSync(path.resolve(__dirname, '../layout.tsx'), 'utf8')
const dialog = fs.readFileSync(path.resolve(__dirname, '../../../components/ui/support-link.tsx'), 'utf8')

/** Each `return (` of the layout component is one shell the app can render. */
function shells(source: string): string[] {
  const body = source.slice(source.indexOf('export default async function DashboardLayout'))
  return body.split(/\n\s*return \(\n/).slice(1)
}

describe('the ?support=1 deep link', () => {
  it('is mounted in every dashboard shell, the company one included', () => {
    const all = shells(layout)
    expect(all.length).toBeGreaterThanOrEqual(3)
    for (const shell of all) expect(shell).toContain('<SupportDialogHost />')
  })

  it('the company shell (the one that identifies analytics) mounts it', () => {
    const company = shells(layout).find((s) => s.includes('<AnalyticsIdentify'))
    expect(company).toBeDefined()
    expect(company).toContain('<SupportDialogHost />')
  })
})

describe('the support dialog decides only once Support has loaded', () => {
  it('bootstrap waits for readiness before falling back to the mail form', () => {
    const body = dialog.slice(dialog.indexOf('const bootstrap = useCallback'))
    const waitAt = body.indexOf('await whenConversationsReady()')
    const emailAt = body.indexOf("setView('email')")
    expect(waitAt).toBeGreaterThan(-1)
    expect(emailAt).toBeGreaterThan(waitAt)
  })

  it('never asks the SDK once at open', () => {
    expect(dialog).not.toMatch(/conversationsAvailable\(\)/)
  })

  it('the trigger dot asks for tickets after readiness too', () => {
    const effect = dialog.slice(dialog.indexOf('// Unread dot on the trigger'))
    expect(effect.indexOf('whenConversationsReady()')).toBeGreaterThan(-1)
    expect(effect.indexOf('whenConversationsReady()')).toBeLessThan(effect.indexOf('listTickets()'))
  })
})
