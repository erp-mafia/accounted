import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { DOCS_NAV } from '@/lib/docs/nav'
import { LANDING_MD } from '@/lib/docs/content/landing'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'accounted API · Documentation',
  description: 'Swedish double-entry bookkeeping as a public REST API for agents and integrations.',
}

export default function DocsApiLandingPage() {
  // Highlight the cookbook + reference grids on the landing page itself,
  // Stripe-style cards. The markdown body provides the prose context;
  // the cards below give visual scannability.
  const cookbooks = DOCS_NAV.find((s) => s.label === 'Cookbooks')?.links ?? []
  const reference = DOCS_NAV.find((s) => s.label === 'API reference')?.links?.slice(0, 8) ?? []

  return (
    <DocsLayout currentPath="/docs/api">
      <DocsMarkdown source={LANDING_MD} />

      <section className="mt-16">
        <h2 className="font-display text-2xl tracking-tight mb-4 pb-2 border-b border-border">Cookbooks</h2>
        <p className="text-[15px] leading-7 text-foreground/80 mb-6">
          End-to-end recipes for the most common integrations. Copy-paste ready, tested against an empty company with a live key.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cookbooks.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className="block rounded-lg border border-border p-5 hover:bg-secondary/40 transition-colors"
            >
              <div className="font-display text-lg tracking-tight mb-1">{c.label}</div>
              {c.summary && (
                <div className="text-[13px] text-muted-foreground leading-relaxed">{c.summary}</div>
              )}
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-16">
        <h2 className="font-display text-2xl tracking-tight mb-4 pb-2 border-b border-border">API reference</h2>
        <p className="text-[15px] leading-7 text-foreground/80 mb-6">
          Every endpoint, grouped by resource. Auto-generated from the same Zod registry that powers the OpenAPI spec, MCP tools, and runtime validators.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {reference.map((r) => (
            <Link
              key={r.href}
              href={r.href}
              className="block rounded-lg border border-border px-3 py-2 hover:bg-secondary/40 transition-colors text-sm"
            >
              {r.label}
            </Link>
          ))}
          <Link
            href="/docs/api/reference"
            className="block rounded-lg border border-border px-3 py-2 hover:bg-secondary/40 transition-colors text-sm text-muted-foreground"
          >
            See all →
          </Link>
        </div>
      </section>
    </DocsLayout>
  )
}
