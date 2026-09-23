import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectTsxFiles(full, out)
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

function isClientComponent(source: string): boolean {
  return /^\s*(['"])use client\1/.test(source)
}

/**
 * EmptyState is a Client Component and its `icon` prop is a COMPONENT
 * reference (`icon?: LucideIcon`), not an element. lucide builds every icon
 * with forwardRef, so a Server Component that passes `icon={SomeIcon}` hands
 * Flight a raw function and the render throws before the page ever reaches the
 * browser: /byra/kpi 500'd into the dashboard error boundary for exactly this
 * reason (digest 1621801304), and only for byråer with zero client companies,
 * so it slipped through every manual pass.
 *
 * The sanctioned shape is a prop-free preset in empty-state.tsx: a client
 * component reference IS serializable, and the icon never crosses a boundary.
 */
describe('EmptyState icon prop never crosses the RSC boundary', () => {
  it('is only passed from client components', () => {
    const files = [
      ...collectTsxFiles(path.join(repoRoot, 'app')),
      ...collectTsxFiles(path.join(repoRoot, 'components')),
    ]

    const offenders = files.filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      if (isClientComponent(source)) return false
      // `[^>]*` keeps the match inside a single JSX element, newlines included.
      return /<EmptyState\b[^>]*\bicon=\{/.test(source)
    })

    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([])
  })
})

describe('byrå KPI empty state', () => {
  const pagePath = path.join(repoRoot, 'app', '(dashboard)', 'byra', 'kpi', 'page.tsx')

  it('renders the preset from the server page instead of passing an icon', () => {
    const source = fs.readFileSync(pagePath, 'utf8')
    expect(isClientComponent(source)).toBe(false)
    expect(source).toMatch(/<EmptyByraClients\s*\/>/)
    expect(source).not.toMatch(/from 'lucide-react'/)
  })

  it('keeps the icon and the copy in the preset', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'components', 'ui', 'empty-state.tsx'), 'utf8')
    expect(source).toMatch(/export function EmptyByraClients\(\)/)
    expect(source).toMatch(/icon=\{TrendingUp\}/)
    // Variable-agnostic: the preset reads from the `byra` namespace under its
    // own translator name, so assert the keys, not the caller's identifier.
    expect(source).toMatch(/\w+\('kpi_empty_title'\)/)
    expect(source).toMatch(/\w+\('kpi_empty_description'\)/)
  })
})
