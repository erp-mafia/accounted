'use client'

import { Children, cloneElement, createContext, isValidElement, useContext, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronLeftIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { FIELD_CLASS } from '@/components/ui/field-classes'
import { HelpPopover, type HelpPopoverContent } from '@/components/ui/help-popover'
import { openNativePicker } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ViewerLock } from '@/components/ui/viewer-lock'
import { SettingsTopBarPortal, useSettingsTopBarSlots } from './SettingsTopBar'
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
 * The Fönster settings language (approved concept 2026-07-25,
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
 *
 * One named exception: the connection rows on Kopplingar show the first
 * sentence of their help as a muted line under the name (ConnectionLabel in
 * sections/ConnectionsSettingsContent.tsx). It is not a pattern to copy.
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
  // On a settings page the top bar is the section's header (it already
  // carries the section's name, from the sidebar's own labels): the help and
  // the action move up there and nothing is drawn in the page flow, so a page
  // never shows a second title (design convention 2). A brand mark stays, as
  // a small line of its own.
  const topBar = useSettingsTopBarSlots()
  if (topBar) {
    return (
      <>
        {intro ? (
          <SettingsTopBarPortal slot="help">
            <HelpPopover className="shrink-0">{intro}</HelpPopover>
          </SettingsTopBarPortal>
        ) : null}
        {action ? <SettingsTopBarPortal slot="action">{action}</SettingsTopBarPortal> : null}
        {mark ? <div className="flex min-h-9 items-center leading-none">{mark}</div> : null}
      </>
    )
  }
  return (
    <header className="flex min-h-9 items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        {mark ? <span className="shrink-0 leading-none">{mark}</span> : null}
        {/* data-ph-unmask: settings chrome (titles, labels) is static i18n
            text in session replays; values and controls stay masked. */}
        <h2 data-ph-unmask="" className="text-[15px] font-medium leading-[22px] text-strong">{title}</h2>
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
  // The settings top bar names the hub before the page's own name.
  const topBar = useSettingsTopBarSlots()
  if (topBar) return null
  return (
    <Link
      href={href}
      className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
    >
      <ChevronLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
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
  /**
   * Kept for call sites: every group fills the settings column, which the
   * shell centres at 880px.
   */
  wide?: boolean
}

export function SettingsGroup({ label, help, children, className, wide: _wide = false }: SettingsGroupProps) {
  const inSettings = useSettingsTopBarSlots() !== null
  return (
    <section className={cn('pt-10', inSettings ? 'first:pt-4' : 'first:pt-8', className)}>
      {label ? (
        <p
          className={cn(
            'flex items-center gap-2 border-b-hairline pb-2 font-medium',
            // On a settings page the top bar is the title, so a group is the
            // page's own section heading (15px); embedded in a form or a
            // dialog elsewhere it stays the quiet eyebrow over its rows.
            inSettings ? 'text-[15px] leading-[22px] text-strong' : 'text-xs text-muted-foreground',
          )}
        >
          <span data-ph-unmask="">{label}</span>
          {help ? <HelpPopover className="shrink-0">{help}</HelpPopover> : null}
        </p>
      ) : null}
      <div>{children}</div>
    </section>
  )
}

const SettingsViewerScopeContext = createContext(false)

/**
 * Company settings a read-only member cannot change: every SettingsRow inside
 * locks its control column (ViewerLock), while the label and its "?" help stay
 * live. Renders no element. Settings that belong to the user stay outside it.
 */
export function SettingsViewerScope({ children }: { children: React.ReactNode }) {
  return <SettingsViewerScopeContext.Provider value={true}>{children}</SettingsViewerScopeContext.Provider>
}

interface SettingsRowProps {
  label: React.ReactNode
  /** Ties the label to a control; renders a <label> instead of a <span>. */
  htmlFor?: string
  /** Row help content: goes behind a "?" next to the label, never inline. */
  help?: HelpPopoverContent
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
  const viewerScoped = useContext(SettingsViewerScopeContext)
  // A bare switch is pushed to the column's end edge so every toggle in the
  // settings lines up with the buttons above and below it.
  const content = Children.map(children, (child) =>
    isValidElement<{ className?: string }>(child) && child.type === Switch
      ? cloneElement(child, { className: cn('ml-auto', child.props.className) })
      : child,
  )
  // The two columns come from the row's own width, not the viewport's: the
  // settings content shares the screen with the nav, the settings rail and a
  // docked assistant, so at a viewport breakpoint the 400px control column
  // squeezed the label to nothing and the two ran into each other. Below
  // 640px (the control column, the gap and a ~13rem label) the row stacks.
  return (
    <div className="@container">
      <div
        className={cn(
          'grid grid-cols-1 gap-2 py-3 @min-[640px]:min-h-[60px] @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,var(--settings-control-w))] @min-[640px]:gap-x-8',
          align === 'center' ? '@min-[640px]:items-center' : '@min-[640px]:items-baseline',
          !borderless && 'border-b-hairline',
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
          {viewerScoped ? <ViewerLock>{content}</ViewerLock> : content}
        </div>
      </div>
    </div>
  )
}

/** Right-aligned slot inside a row (quiet actions, secondary values). */
export function SettingsRowEnd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('ml-auto flex shrink-0 items-center gap-3', className)}>{children}</div>
}

/**
 * Muted secondary text inside a row. `fill` is for a state beside the row's
 * actions: it takes the room left of them and wraps there, so a long state
 * never pushes the buttons onto a line of their own below it.
 */
export function SettingsRowNote({ children, className, fill = false }: { children: React.ReactNode; className?: string; fill?: boolean }) {
  return <span className={cn('text-xs text-muted-foreground', fill && 'min-w-0 flex-1 basis-0', className)}>{children}</span>
}

/**
 * The boxed field look shared by SettingsInput, SettingsTextarea and the
 * SettingsSelect trigger: they fill the control column, so the text inside
 * every field starts on the same line.
 */
const SETTINGS_FIELD_CLASS = cn(FIELD_CLASS, 'min-w-0 flex-1 px-2.5')

/**
 * Boxed text input that fills the control column (read-only values render
 * disabled). A date field opens its calendar on a click anywhere, as the
 * shared Input does: in Chromium a click on the text only selects a segment,
 * and the settings date fields (fiscal year, lock date) were rage-clicked.
 */
export function SettingsInput({ className, onClick, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) openNativePicker(e.currentTarget)
      }}
      className={cn(SETTINGS_FIELD_CLASS, 'h-8 pointer-coarse:h-10', className)}
    />
  )
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
/** The SettingsSelect trigger's look, for a field-shaped picker of another kind (the attest settings' people picker). */
export const SETTINGS_SELECT_TRIGGER_CLASS = cn(SETTINGS_FIELD_CLASS, 'h-8 w-full cursor-pointer justify-between gap-2 pointer-coarse:h-10')

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
                  className="text-xs"
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
        <div className={cn(indent && 'ml-3 border-l-hairline pl-4')}>{children}</div>
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
    <div role="group" aria-label={ariaLabel} className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-secondary/80 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          data-ph-unmask=""
          className={cn(
            'h-full rounded-md px-3 text-[13px] font-medium transition-[background-color,box-shadow,color] duration-150 disabled:cursor-not-allowed disabled:opacity-40',
            o.value === value
              ? 'bg-control text-strong shadow-raised'
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
export function SettingsDangerZone({
  label,
  help,
  children,
}: {
  label: string
  /** Zone-level help ("?" after the label) for what holds for every row. */
  help?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mt-10 border-t-hairline pt-3">
      <p className="flex items-center gap-2 px-1 text-xs font-medium text-destructive/80">
        <span data-ph-unmask="">{label}</span>
        {help ? <HelpPopover className="shrink-0">{help}</HelpPopover> : null}
      </p>
      <div>{children}</div>
    </section>
  )
}
