import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SourceCodeFooter } from '@/components/branding/SourceCodeFooter'
import { LEGAL_PROVIDER } from '@/lib/legal/documents'

/**
 * Frame shared by the public legal pages (/terms, /privacy, /dpa,
 * /subprocessors). The documents are Swedish in both locales: they are the
 * binding text, and a translation would be a second version to keep in step.
 */
export function LegalShell({
  title,
  subtitle,
  updatedAt,
  children,
}: {
  title: string
  subtitle?: string
  updatedAt: string
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh bg-background py-12 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center mb-8">
          <h1 className="text-3xl text-foreground mb-2">{title}</h1>
          {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
          <p className="text-muted-foreground">Senast uppdaterad: {updatedAt}</p>
        </div>
        {children}
        <p className="text-center text-xs text-muted-foreground">
          {LEGAL_PROVIDER.name} · Org.nr {LEGAL_PROVIDER.orgNumber} · Momsreg.nr{' '}
          {LEGAL_PROVIDER.vatNumber} · {LEGAL_PROVIDER.address} · Styrelsens säte:{' '}
          {LEGAL_PROVIDER.seat} · {LEGAL_PROVIDER.email}
        </p>
        {/* AGPL section 13 source offer (WL-06): renders on both default and
            branded hosts; never gate this on a brand. */}
        <SourceCodeFooter className="pt-2" />
      </div>
    </div>
  )
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="prose prose-sm dark:prose-invert max-w-none">{children}</CardContent>
    </Card>
  )
}

/** A plain table in the legal pages' style; rows are arrays of cells. */
export function LegalTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto mt-4">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b">
            {head.map((h) => (
              <th key={h} className="text-left py-2 pr-4 font-semibold align-top">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-b">
              {cells.map((cell, j) => (
                <td key={j} className={`py-2 pr-4 align-top ${j === 0 ? 'font-medium' : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
