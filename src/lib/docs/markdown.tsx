/**
 * Shared Markdown renderer for the /docs/api surface.
 *
 * Two modes:
 *   - <DocsMarkdown> renders Markdown source as styled JSX inside a docs page.
 *   - getMarkdownSource() returns the raw string for the sibling .md route handlers.
 *
 * Stripe-inspired typography rules baked in:
 *   - Hedvig serif headlines (font-display)
 *   - Tabular nums on code, monospaced via Geist Mono
 *   - Hairline horizontal rules between top-level sections
 *   - Code blocks: paper-white surface, single-pixel border, no shadow
 *   - Tables: only used by the auto-generated reference; flat hairline rows
 */

import ReactMarkdown from 'react-markdown'
import { cn } from '@/lib/utils'

interface DocsMarkdownProps {
  source: string
  className?: string
}

export function DocsMarkdown({ source, className }: DocsMarkdownProps) {
  return (
    <div className={cn('docs-prose', className)}>
      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1 className="font-display text-4xl tracking-tight mb-6 mt-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="font-display text-2xl tracking-tight mt-12 mb-4 pb-2 border-b border-border">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="font-display text-xl tracking-tight mt-8 mb-3">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mt-6 mb-2">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="text-[15px] leading-7 text-foreground/90 my-4">{children}</p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground transition-colors"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="my-4 space-y-2 list-disc pl-6 text-[15px] leading-7 text-foreground/90 marker:text-muted-foreground">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-4 space-y-2 list-decimal pl-6 text-[15px] leading-7 text-foreground/90 marker:text-muted-foreground">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          code: ({ className: codeClassName, children, ...props }) => {
            const isBlock = (codeClassName ?? '').startsWith('language-')
            if (isBlock) {
              return (
                <code className={cn('font-mono text-[13px] leading-6 block', codeClassName)} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className="font-mono text-[13px] bg-secondary/60 px-1.5 py-0.5 rounded border border-border/60">
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="my-5 p-4 bg-secondary/40 border border-border rounded-lg overflow-x-auto text-[13px] leading-6 font-mono">
              {children}
            </pre>
          ),
          hr: () => <hr className="my-12 border-border" />,
          blockquote: ({ children }) => (
            <blockquote className="my-5 pl-4 border-l-2 border-border text-foreground/80 italic">
              {children}
            </blockquote>
          ),
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          table: ({ children }) => (
            <div className="my-6 overflow-x-auto">
              <table className="w-full text-[14px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-border">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="text-left px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="px-3 py-2 align-top border-b border-border">{children}</td>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
