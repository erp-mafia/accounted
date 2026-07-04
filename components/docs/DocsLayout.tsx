/**
 * Stripe-inspired two-column docs layout.
 *
 *   ┌────────────────┬──────────────────────────────────────────┐
 *   │                │                                          │
 *   │   Sidebar      │   Main content (max-w-4xl)               │
 *   │   (sticky,     │                                          │
 *   │    grouped)    │                                          │
 *   │                │                                          │
 *   └────────────────┴──────────────────────────────────────────┘
 *
 * Aesthetic: paper-white surfaces, hairline borders, Hedvig display
 * headlines, Geist body. Sidebar entries use the same warm-beige hover
 * + active background as the dashboard sidebar so the docs feel like the
 * same instrument as the app: not a separate marketing site.
 */

import Link from 'next/link'
import { DOCS_NAV } from '@/lib/docs/nav'
import { cn } from '@/lib/utils'

interface DocsLayoutProps {
  /** The pathname of the current page so the sidebar can highlight it. */
  currentPath: string
  children: React.ReactNode
}

export function DocsLayout({ currentPath, children }: DocsLayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/docs/api" className="font-display text-xl tracking-tight" style={{ fontWeight: 700 }}>
            accounted <span className="text-muted-foreground" style={{ fontWeight: 400 }}>/ docs</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/docs/api/reference" className="text-foreground/80 hover:text-foreground transition-colors">
              API reference
            </Link>
            <Link href="/docs/api/cookbook/quickstart" className="text-foreground/80 hover:text-foreground transition-colors">
              Cookbooks
            </Link>
            <Link href="/docs/api/errors" className="text-foreground/80 hover:text-foreground transition-colors">
              Errors
            </Link>
            <Link href="/docs/api/changelog" className="text-foreground/80 hover:text-foreground transition-colors">
              Changelog
            </Link>
            <Link
              href="/api/v1/openapi.json"
              className="text-foreground/80 hover:text-foreground transition-colors font-mono text-xs"
            >
              openapi.json
            </Link>
          </nav>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-12 py-10">
        <aside className="hidden md:block">
          <div className="sticky top-24 space-y-8">
            {DOCS_NAV.map((section) => (
              <div key={section.label}>
                <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2 px-3">
                  {section.label}
                </h3>
                <ul className="space-y-px">
                  {section.links.map((link) => {
                    const isActive = stripFragment(link.href) === currentPath
                    return (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          className={cn(
                            'block text-sm px-3 py-1.5 rounded-md transition-colors',
                            isActive
                              ? 'bg-secondary text-foreground font-medium'
                              : 'text-foreground/75 hover:bg-secondary/60 hover:text-foreground',
                          )}
                        >
                          {link.label}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </aside>

        <main className="min-w-0 max-w-4xl">
          {children}
        </main>
      </div>

      <footer className="border-t border-border mt-20">
        <div className="max-w-7xl mx-auto px-6 py-8 text-sm text-muted-foreground flex items-center justify-between">
          <span>accounted REST API · Swedish bookkeeping for agents</span>
          <span className="font-mono text-xs">AGPL-3.0-or-later</span>
        </div>
      </footer>
    </div>
  )
}

function stripFragment(href: string): string {
  const hashIdx = href.indexOf('#')
  return hashIdx === -1 ? href : href.slice(0, hashIdx)
}
