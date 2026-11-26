import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The cross-tab company guard (components/dashboard/CompanyTabSync) must be
 * mounted in every shell the dashboard layout can render. The layout renders
 * the books act (/onboarding/books) through DashboardRouteShell's `onboarding`
 * branch, a bare shell of its own, so that branch mounts the guard itself.
 */
const root = path.resolve(__dirname, '../../../')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

describe('the company guard in the dashboard layout', () => {
  const layout = read('app/(dashboard)/layout.tsx')

  it('the books act branch mounts the guard, before the act itself', () => {
    const start = layout.indexOf('onboarding={')
    expect(start).toBeGreaterThan(-1)
    // The branch ends where DashboardRouteShell's children (the full shell) begin.
    const end = layout.indexOf('<AgentSheetProvider', start)
    expect(end).toBeGreaterThan(start)
    const branch = layout.slice(start, end)
    const guard = branch.indexOf('<CompanyTabSync />')
    expect(guard).toBeGreaterThan(-1)
    // The act is the branch's `children`: the guard comes first.
    const act = branch.indexOf(': children}')
    expect(act).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(act)
  })

  it('every shell the layout returns mounts the guard', () => {
    // Three returns render a shell (no company yet, the home-domain signpost, the dashboard), and the books act branch is the fourth mount.
    expect(layout.match(/<CompanyTabSync \/>/g)?.length).toBe(4)
  })

  it('the route shell swaps the two branches on the books path only', () => {
    const shell = read('components/dashboard/DashboardRouteShell.tsx')
    expect(shell).toContain('return isBooksOnboarding ? onboarding : children')
  })
})
