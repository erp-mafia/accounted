'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ContextFamily, ContextSection } from '@/lib/agent-context/context-window'

/**
 * The pieces the wiki's context view and record pages share: the scope
 * stack, the window bar and the raw text an agent reads.
 *
 * Colour encodes the family of a part only (what people and agents taught
 * it, what Accounted reads, the instructions): the v3 chart pair (blue,
 * ochre) and a neutral for the instructions, checked for colour-blind
 * separation in light and dark. Every part is also named in text beside its
 * swatch, so colour is never the only cue.
 */
export const FAMILY_COLOR: Record<ContextFamily, string> = {
  taught: 'hsl(var(--chart-1))',
  read: 'hsl(var(--chart-2))',
  instructions: 'hsl(var(--chart-4) / 0.45)',
}

export function Swatch({ family, className }: { family: ContextFamily; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block h-2 w-2 shrink-0 rounded-sm', className)} style={{ backgroundColor: FAMILY_COLOR[family] }} />
}

export interface ScopeLevel {
  level: 'group' | 'company' | 'record'
  name: string
  detail?: string | null
}

/**
 * Where the knowledge applies, widest first: the group, the company, the
 * record. A flat tree on the panel (the sidebar's sub-item line), no boxes.
 */
export function ScopeStack({ levels }: { levels: ScopeLevel[] }) {
  const t = useTranslations('wiki')
  return (
    <dl aria-label={t('scope_label')} className="space-y-1 text-[13px]">
      {levels.map((l, i) => (
        <div
          key={l.level}
          className={cn('flex min-w-0 items-baseline gap-3', i > 0 && 'border-l-hairline pl-3')}
          style={i > 0 ? { marginLeft: `${(i - 1) * 12 + 4}px` } : undefined}
        >
          <dt className="w-16 shrink-0 text-xs text-muted-foreground">{t(`scope_${l.level}`)}</dt>
          <dd className="min-w-0 truncate" data-ph-mask="">
            <span className="text-strong">{l.name}</span>
            {l.detail ? <span className="text-muted-foreground"> · {l.detail}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The window as one thin segmented bar: a block per part, widths in
 * proportion to its characters, 2px gaps, coloured by family. No text on
 * the bar: the parts below carry their names and sizes (the thin-bar form).
 */
export function ContextBar({ sections, total }: { sections: ContextSection[]; total: number }) {
  const t = useTranslations('wiki')
  const parts = sections.filter((s) => s.chars > 0)
  const sum = parts.reduce((n, s) => n + s.chars, 0) || 1
  const label = `${t('window_bar_label')}: ${parts
    .map((s) => `${t(`sections.${s.id}`)} ${Math.round((s.chars / sum) * 100)} %`)
    .join(', ')}`
  return (
    <div role="img" aria-label={label} data-total={total} className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
      {parts.map((s) => (
        <span
          key={s.id}
          title={`${t(`sections.${s.id}`)}: ${t('section_size', { chars: s.chars.toLocaleString('sv-SE') })}`}
          className="h-full min-w-1 first:rounded-l-full last:rounded-r-full"
          style={{ flexGrow: s.chars, flexBasis: 0, backgroundColor: FAMILY_COLOR[s.family] }}
        />
      ))}
    </div>
  )
}

/** "Visa som agenten ser det": the tool's answer as the agent reads it, with a copy button. */
export function RawText({ text, subject }: { text: string; subject: 'company' | 'record' }) {
  const t = useTranslations('wiki')
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Safe to ignore: the text stays on screen to select by hand.
    }
  }
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? t('raw_hide') : t('raw_show')}
        </Button>
        {open && (
          <Button variant="ghost" onClick={() => void copy()}>
            {copied ? t('raw_copied') : t('raw_copy')}
          </Button>
        )}
      </div>
      {open && (
        <div className="animate-rise space-y-2">
          <div className="text-xs text-muted-foreground">{t(subject === 'company' ? 'raw_note_company' : 'raw_note_record')}</div>
          <pre
            data-ph-mask=""
            className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-xs leading-5 text-foreground"
          >
            {text}
          </pre>
        </div>
      )}
    </section>
  )
}
