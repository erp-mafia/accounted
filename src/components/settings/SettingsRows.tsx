'use client'

import { Children, cloneElement, isValidElement, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HelpPopover } from '@/components/ui/help-popover'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * The Fönster settings language (founder-approved concept 2026-07-25,
 * full-page grid 2026-09-24): flat hairline rows with the label on the left
 * and every control in ONE fixed-width column on the right, so fields,
 * selects and read-only values start on the same line and buttons and
 * switches end on the same line on every row of every section. Section
 * titles in the display serif, groups under eyebrow labels, and every
 * explanation (the section intro included) behind a "?" popover
 * (UI-migration convention 7).
 *
 * All settings sections compose these primitives; do not hand-roll row
 * layouts or inline help paragraphs in section components.
 */

interface SettingsSectionHeaderProps {
  title: string
  /** What the section is for: shown behind the "?" beside the title. */
  intro?: React.ReactNode
  /** Right-aligned header action (e.g. "Förhandsvisa faktura", "Skapa nyckel"). */
  action?: React.ReactNode
  /**
   * Brand mark for a section that represents a third-party channel
   * (WhatsApp today). Sections that are just Accounted settings leave this
   * unset: the serif title carries them, and a decorative icon per tab
   * would turn the settings rail into a sticker album.
   */
  mark?: React.ReactNode
}

export function SettingsSectionHeader({ title, intro, action, mark }: SettingsSectionHeaderProps) {
  return (
    <header className="flex min-h-9 items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        {mark ? <span className="shrink-0 leading-none">{mark}</span> : null}
        {/* data-ph-unmask: settings chrome (titles, labels) is static i18n
            text in session replays; values and controls stay masked. */}
        <h2 data-ph-unmask="" className="font-display text-2xl tracking-tight">{title}</h2>
        {intro ? <HelpPopover className="shrink-0">{intro}</HelpPopover> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-3">{action}</div> : null}
    </header>
  )
}

/**
 * Quiet "← Kopplingar" link above the header of a page that is reached from a
 * hub section rather than from the rail (the bank, Skatteverket, Peppol and
 * WhatsApp pages under Kopplingar).
 */
export function SettingsBackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mb-2 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
    >
      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Link>
  )
}

interface SettingsGroupProps {
  /** Chrome in session replays (data-ph-unmask): wrap any user data (e.g. a
      team name) in a data-ph-mask element. */
  label?: React.ReactNode
  /** Group-level help ("?" right after the eyebrow) for guidance that spans the rows. */
  help?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function SettingsGroup({ label, help, children, className }: SettingsGroupProps) {
  return (
    <section className={cn('pt-10 first:pt-8', className)}>
      {label ? (
        <p className="flex items-center gap-2 border-b border-border pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <span data-ph-unmask="">{label}</span>
          {help ? <HelpPopover className="shrink-0">{help}</HelpPopover> : null}
        </p>
      ) : null}
      <div>{children}</div>
    </section>
  )
}

interface SettingsRowProps {
  label: React.ReactNode
  /** Ties the label to a control; renders a <label> instead of a <span>. */
  htmlFor?: string
  /** Row help content: goes behind a "?" next to the label, never inline. */
  help?: React.ReactNode
  /** 'center' for toggles/selects/chips, 'baseline' for text inputs. */
  align?: 'center' | 'baseline'
  /** Drop the hairline (last row before a fold/reveal). */
  borderless?: boolean
  children: React.ReactNode
  className?: string
}

export function SettingsRow({
  label,
  htmlFor,
  help,
  align = 'center',
  borderless = false,
  children,
  className,
}: SettingsRowProps) {
  const labelClass = 'text-[13px] text-foreground'
  // A bare switch is pushed to the column's end edge so every toggle in the
  // settings lines up with the buttons above and below it.
  const content = Children.map(children, (child) =>
    isValidElement<{ className?: string }>(child) && child.type === Switch
      ? cloneElement(child, { className: cn('ml-auto', child.props.className) })
      : child,
  )
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-2 py-3 md:min-h-[60px] md:grid-cols-[minmax(0,1fr)_minmax(0,var(--settings-control-w))] md:gap-x-8',
        align === 'center' ? 'md:items-center' : 'md:items-baseline',
        !borderless && 'border-b border-border',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {htmlFor ? (
          <label htmlFor={htmlFor} data-ph-unmask="" className={labelClass}>
            {label}
          </label>
        ) : (
          <span data-ph-unmask="" className={labelClass}>{label}</span>
        )}
        {help ? <HelpPopover className="shrink-0">{help}</HelpPopover> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        {content}
      </div>
    </div>
  )
}

/** Right-aligned slot inside a row (quiet actions, secondary values). */
export function SettingsRowEnd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('ml-auto flex shrink-0 items-center gap-3', className)}>{children}</div>
}

/** Muted secondary text inside a row. */
export function SettingsRowNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('text-[12.5px] text-muted-foreground', className)}>{children}</span>
}

/**
 * The boxed field look shared by SettingsInput, SettingsTextarea and the
 * SettingsSelect trigger: they fill the control column, so the text inside
 * every field starts on the same line.
 */
const SETTINGS_FIELD_CLASS =
  'min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground ' +
  'placeholder:text-muted-foreground/60 transition-colors duration-150 ' +
  'focus-visible:border-foreground/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/20 ' +
  'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground'

/** Boxed text input that fills the control column (read-only values render disabled). */
export function SettingsInput({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(SETTINGS_FIELD_CLASS, 'h-9', className)} />
}

/** Boxed textarea sibling of SettingsInput. */
export function SettingsTextarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(SETTINGS_FIELD_CLASS, 'min-h-24 resize-y py-2 leading-relaxed', className)} />
}

/**
 * Boxed select with a styled popup. Keeps the native-select prop surface so
 * call sites read like a <select> (value/defaultValue, onChange with
 * e.target.value, <option> children, `name` for the wrapper's FormData read)
 * but renders through Radix Select: the native listbox popup cannot be
 * styled and clashes with the panel (same call as TeamPanel's role
 * dropdowns). The trigger is the same box as SettingsInput.
 */
const SETTINGS_SELECT_TRIGGER_CLASS = cn(SETTINGS_FIELD_CLASS, 'h-9 w-full cursor-pointer justify-between gap-2')

// Radix Select refuses empty-string item values; settings selects use '' for
// placeholder-shaped options ("Ingen", "Lägg till valuta"), so '' maps onto a
// sentinel at the Radix boundary and back at the native-shaped one.
const SETTINGS_SELECT_EMPTY = '__settings-select-empty__'
const toRadixValue = (value: string) => (value === '' ? SETTINGS_SELECT_EMPTY : value)
const fromRadixValue = (value: string) => (value === SETTINGS_SELECT_EMPTY ? '' : value)

interface SettingsSelectOption {
  value: string
  label: React.ReactNode
  disabled: boolean
}

type SettingsSelectEntry =
  | { kind: 'option'; option: SettingsSelectOption }
  | { kind: 'group'; label: React.ReactNode; options: SettingsSelectOption[] }

function collectSelectOptions(children: React.ReactNode): SettingsSelectOption[] {
  return collectSelectEntries(children).flatMap((entry) =>
    entry.kind === 'group' ? entry.options : [entry.option],
  )
}

/**
 * Walks native-shaped select children. <option>s become option entries;
 * <optgroup>s become group entries that keep their label (rendered as a
 * non-interactive header row in the popup, e.g. the ROT/RUT work-type
 * groups in ArticleForm); fragments/arrays are flattened transparently.
 */
function collectSelectEntries(children: React.ReactNode): SettingsSelectEntry[] {
  const entries: SettingsSelectEntry[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    if (child.type === 'option') {
      const props = child.props as React.OptionHTMLAttributes<HTMLOptionElement>
      entries.push({
        kind: 'option',
        option: {
          value: String(props.value ?? ''),
          label: props.children,
          disabled: !!props.disabled,
        },
      })
      return
    }
    if (child.type === 'optgroup') {
      const props = child.props as React.OptgroupHTMLAttributes<HTMLOptGroupElement>
      entries.push({
        kind: 'group',
        label: props.label,
        options: collectSelectOptions(props.children),
      })
      return
    }
    // Fragments / arrays of options: flatten.
    entries.push(
      ...collectSelectEntries((child.props as { children?: React.ReactNode }).children),
    )
  })
  return entries
}

export function SettingsSelect({
  className,
  wrapperClassName,
  children,
  id,
  name,
  value,
  defaultValue,
  disabled,
  onChange,
  onInput,
  'aria-label': ariaLabel,
}: React.SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }) {
  const entries = collectSelectEntries(children)
  const options = entries.flatMap((entry) =>
    entry.kind === 'group' ? entry.options : [entry.option],
  )
  const isControlled = value !== undefined
  // Uncontrolled fallback mirrors the native select: defaultValue if given,
  // else the first option.
  const [internalValue, setInternalValue] = useState<string>(() =>
    defaultValue !== undefined ? String(defaultValue) : (options[0]?.value ?? ''),
  )
  const hiddenInputRef = useRef<HTMLInputElement>(null)
  const currentValue = isControlled ? String(value) : internalValue

  const handleValueChange = (encoded: string) => {
    const next = fromRadixValue(encoded)
    if (!isControlled) setInternalValue(next)
    // SettingsFormWrapper tracks dirtiness via bubbling input events; the
    // Radix trigger is a button and fires none, so raise the event from the
    // hidden input. Call sites that opt out of dirty tracking pass an
    // onInput stopPropagation handler, which attaches there and still
    // intercepts.
    hiddenInputRef.current?.dispatchEvent(new Event('input', { bubbles: true }))
    onChange?.({ target: { value: next } } as unknown as React.ChangeEvent<HTMLSelectElement>)
  }

  return (
    <span className={cn('relative flex min-w-0 flex-1 items-center', wrapperClassName)}>
      {/* Carries `name` into the wrapper's FormData and hosts the dirty-
          tracking input event; type="hidden" keeps it out of the tab order. */}
      <input
        ref={hiddenInputRef}
        type="hidden"
        name={name}
        value={currentValue}
        onInput={onInput as unknown as React.FormEventHandler<HTMLInputElement>}
        readOnly
      />
      <Select
        value={toRadixValue(currentValue)}
        onValueChange={handleValueChange}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          aria-label={ariaLabel}
          className={cn(SETTINGS_SELECT_TRIGGER_CLASS, className)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {entries.map((entry, index) =>
            entry.kind === 'group' ? (
              /* Radix Label rows are not Items: arrow-key navigation and
                 typeahead skip them; they render as muted eyebrow headers. */
              <SelectGroup key={`group-${index}`}>
                <SelectLabel
                  data-ph-unmask=""
                  className="text-[11px] uppercase tracking-wider"
                >
                  {entry.label}
                </SelectLabel>
                {entry.options.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={toRadixValue(option.value)}
                    disabled={option.disabled}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : (
              <SelectItem
                key={entry.option.value}
                value={toRadixValue(entry.option.value)}
                disabled={entry.option.disabled}
              >
                {entry.option.label}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </span>
  )
}

interface SettingsRevealProps {
  open: boolean
  /** Indent revealed rows behind a left hairline (gated sub-settings). */
  indent?: boolean
  children: React.ReactNode
}

/** Animated reveal for settings gated behind a toggle (momsreg → momsblock). */
export function SettingsReveal({ open, indent = true, children }: SettingsRevealProps) {
  return (
    <div
      inert={!open}
      className={cn(
        'grid transition-[grid-template-rows] duration-300 motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={cn(indent && 'ml-3 border-l border-border pl-4')}>{children}</div>
      </div>
    </div>
  )
}

interface SettingsSegProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: Array<{ value: T; label: React.ReactNode }>
  'aria-label': string
  disabled?: boolean
}

/** Quiet segmented control (theme, language, plan interval, sv/en texts). */
export function SettingsSeg<T extends string>({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
  disabled,
}: SettingsSegProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex items-center gap-1 rounded-lg bg-muted/70 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          data-ph-unmask=""
          className={cn(
            'rounded-sm px-3 py-1 text-xs transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60',
            o.value === value
              ? 'border border-border bg-card font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Terracotta-tinted trailing block for destructive actions. */
export function SettingsDangerZone({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 border-t border-destructive/30 pt-3">
      <p data-ph-unmask="" className="px-1 text-[11px] font-medium uppercase tracking-wider text-destructive/80">
        {label}
      </p>
      <div>{children}</div>
    </section>
  )
}
