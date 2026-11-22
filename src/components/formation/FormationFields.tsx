'use client'

import type { ReactNode } from 'react'
import { useId } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { FormationIssue } from '@/lib/formation/rules'

/** The issues for one field path, as the lines under it. */
export function FieldIssues({ issues, id }: { issues: FormationIssue[]; id?: string }) {
  const t = useTranslations('formation.issues')
  if (issues.length === 0) return null
  return (
    <div id={id} className="mt-1 space-y-0.5">
      {issues.map((issue, i) => (
        <p key={`${issue.code}-${i}`} className={cn('text-xs', issue.severity === 'error' ? 'text-destructive' : 'text-attn')}>
          {t(issue.code, { ...issue.params, ...(issue.params && 'name' in issue.params && !issue.params.name ? { name: t('unnamed') } : {}) })}
        </p>
      ))}
    </div>
  )
}

/** A labelled text field with its help and issues under it. */
export function TextField({
  label,
  value,
  onChange,
  issues = [],
  help,
  optional,
  placeholder,
  inputMode,
  autoComplete,
  className,
  mask,
  maxLength,
}: {
  label: ReactNode
  value: string
  onChange: (value: string) => void
  issues?: FormationIssue[]
  help?: ReactNode
  optional?: boolean
  placeholder?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  autoComplete?: string
  className?: string
  /** Hide the value from session recordings (names, numbers). */
  mask?: boolean
  maxLength?: number
}) {
  const id = useId()
  const describedBy = issues.length > 0 ? `${id}-issues` : help ? `${id}-help` : undefined
  return (
    <div className={cn('min-w-0', className)}>
      <Label htmlFor={id} optional={optional}>
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        maxLength={maxLength}
        aria-invalid={issues.some((i) => i.severity === 'error') || undefined}
        aria-describedby={describedBy}
        className="mt-1.5"
        {...(mask ? { 'data-ph-mask': '' } : {})}
      />
      {issues.length > 0 ? (
        <FieldIssues issues={issues} id={`${id}-issues`} />
      ) : help ? (
        <p id={`${id}-help`} className="mt-1 text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  )
}

/** A whole number field (kronor, aktier) that keeps digits only. */
export function NumberField(props: Omit<Parameters<typeof TextField>[0], 'value' | 'onChange' | 'inputMode'> & { value: number | null; onChange: (value: number | null) => void }) {
  const { value, onChange, ...rest } = props
  const shown = value === null ? '' : new Intl.NumberFormat('sv-SE').format(value)
  return (
    <TextField
      {...rest}
      inputMode="numeric"
      value={shown}
      onChange={(raw) => {
        const digits = raw.replace(/[^\d-]/g, '')
        onChange(digits === '' || digits === '-' ? null : Number(digits))
      }}
    />
  )
}

/**
 * One choice among a few, as raised options (the single-object surface).
 * role="radiogroup" with a radio per option, arrow keys move between them.
 */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  columns = 1,
}: {
  label?: ReactNode
  value: T | null
  options: Array<{ value: T; label: ReactNode; hint?: ReactNode }>
  onChange: (value: T) => void
  /** 3 keeps one row on a phone too: for short labels only (Kvartal, Månad, År). */
  columns?: 1 | 2 | 3 | 4
}) {
  const id = useId()
  return (
    <div>
      {label && (
        <p id={id} className="mb-1.5 text-xs font-medium text-foreground">
          {label}
        </p>
      )}
      <div
        role="radiogroup"
        aria-labelledby={label ? id : undefined}
        className={cn('grid gap-2', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'grid-cols-3', columns === 4 && 'grid-cols-2 sm:grid-cols-4')}
        onKeyDown={(e) => {
          if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) return
          e.preventDefault()
          const i = Math.max(0, options.findIndex((o) => o.value === value))
          const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % options.length : (i - 1 + options.length) % options.length
          onChange(options[next].value)
          const buttons = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]')
          buttons[next]?.focus()
        }}
      >
        {options.map((o) => {
          const selected = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (value === null && o === options[0]) ? 0 : -1}
              onClick={() => onChange(o.value)}
              className={cn(
                'flex min-h-10 w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left text-sm shadow-raised transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
                selected ? 'bg-secondary text-strong' : 'bg-control text-foreground hover:bg-secondary/60',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('mt-1 h-3 w-3 shrink-0 rounded-full border border-border', selected && 'border-strong bg-strong')}
              />
              <span className="min-w-0">
                <span className="block font-medium">{o.label}</span>
                {o.hint && <span className="mt-0.5 block text-xs text-muted-foreground">{o.hint}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Toggle chips for roles: several may be on at once. */
export function ToggleChips<T extends string>({
  options,
  value,
  onToggle,
  label,
}: {
  options: Array<{ value: T; label: ReactNode; disabled?: boolean }>
  value: readonly T[]
  onToggle: (value: T) => void
  label?: string
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={o.disabled && !on}
            onClick={() => onToggle(o.value)}
            className={cn(
              'h-7 rounded-md px-2.5 text-xs font-medium shadow-raised transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-40 pointer-coarse:min-h-10',
              on ? 'bg-secondary text-strong' : 'bg-control text-foreground/80 hover:bg-secondary/60',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** A section inside a step: a 15px title and its fields, no box. */
export function StepSection({ title, help, children, className }: { title?: ReactNode; help?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-3', className)}>
      {title && (
        <div>
          <h2 className="text-base font-medium text-strong">{title}</h2>
          {help && <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>}
        </div>
      )}
      {children}
    </section>
  )
}
