import * as React from "react"
import { useTranslations } from "next-intl"
import { CalendarIcon } from "@/components/icons"
import { cn } from "@/lib/utils"
import { Button } from "./button"
import { FIELD_CLASS, FIELD_LINE_CLASS } from "./field-classes"
import {
  dateRangeIssue,
  dateTarget,
  liveTypedDate,
  parseTypedDate,
  retargetEvent,
  settleTypedDate,
  splitDateFieldClassName,
} from "./typed-date"

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

/**
 * No form has this id: the date field's hidden calendar input belongs to no
 * form, so it is never submitted and its min/max never block a submit (the
 * text field carries the validity).
 */
const DETACHED_FORM = "date-field-calendar"

/**
 * `<Input type="date">` (crm#1954): a text field a date can be typed into
 * (`2026-10-23`, `20261023`, `261023`, `23/10`), normalised to `YYYY-MM-DD`
 * when the field is left or Enter is pressed, with the calendar one click
 * away on its icon (or Alt+Down / F4). A click on the text places the cursor;
 * it used to open the calendar, which in Chromium and Edge left no way to
 * type a date.
 *
 * A drop-in for the native date input: controlled (`value` + `onChange`) and
 * uncontrolled (`defaultValue`, `name`, react-hook-form `register()`) callers
 * only ever see a complete `YYYY-MM-DD` date or `''` in `e.target.value`.
 */
const DateInput = React.forwardRef<HTMLInputElement, Omit<InputProps, "type">>(function DateInput(
  {
    className,
    value,
    defaultValue,
    onChange,
    onBlur,
    onFocus,
    onKeyDown,
    min,
    max,
    disabled,
    readOnly,
    placeholder,
    "aria-invalid": ariaInvalid,
    ...props
  },
  ref
) {
  const t = useTranslations("common")
  const fieldRef = React.useRef<HTMLInputElement | null>(null)
  const calendarRef = React.useRef<HTMLInputElement | null>(null)
  // The date an uncontrolled field's caller last heard: read when the field
  // gains focus (react-hook-form's setValue writes the DOM directly), then
  // kept by every change the field sends.
  const heardRef = React.useRef("")
  const controlled = value !== undefined
  const current = controlled ? String(value) : ""
  // A controlled field shows the text being typed while the caller holds
  // `base`; a new value from the caller replaces it.
  const [draft, setDraft] = React.useState<{ text: string; base: string } | null>(null)
  const [invalid, setInvalid] = React.useState(false)
  const typing = controlled && draft !== null && draft.base === current ? draft.text : null
  const showInvalid = invalid && (!controlled || typing !== null)
  const { box, field } = splitDateFieldClassName(className)

  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      fieldRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )

  const heard = () => (controlled ? current : heardRef.current)

  // A text that is not a date blocks a native submit, as an incomplete native
  // date does; so does a date outside min/max.
  const syncValidity = (node: HTMLInputElement) => {
    const date = parseTypedDate(node.value)
    const range = date ? dateRangeIssue(date, min, max) : null
    node.setCustomValidity(
      date === null
        ? t("date_invalid")
        : range === "early"
          ? t("date_too_early", { date: String(min) })
          : range === "late"
            ? t("date_too_late", { date: String(max) })
            : ""
    )
  }

  // A new value or range from the caller re-checks the field.
  React.useEffect(() => {
    if (fieldRef.current) syncValidity(fieldRef.current)
  })

  const emit = (source: React.SyntheticEvent<HTMLInputElement>, date: string) => {
    heardRef.current = date
    const node = fieldRef.current
    if (node && onChange) {
      onChange(retargetEvent(source, "change", dateTarget(node, date)) as React.ChangeEvent<HTMLInputElement>)
    }
  }

  /** Leaving the field or Enter: normalise the text and hand the caller the date. */
  const settle = (source: React.SyntheticEvent<HTMLInputElement>): string => {
    const node = fieldRef.current
    if (!node) return heard()
    const settled = settleTypedDate(node.value, heard())
    setInvalid(settled.invalid)
    if (controlled) setDraft(settled.invalid ? { text: settled.text, base: settled.date } : null)
    else if (node.value !== settled.text) node.value = settled.text
    if (settled.emit) emit(source, settled.date)
    syncValidity(node)
    return settled.date
  }

  const openCalendar = () => {
    const node = fieldRef.current
    const calendar = calendarRef.current
    if (!node || !calendar || disabled || readOnly) return
    calendar.value = parseTypedDate(node.value) || ""
    try {
      calendar.showPicker?.()
    } catch {
      // Refused (no user activation, a cross-origin frame): typing still works.
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value
    const date = liveTypedDate(text, heard())
    if (parseTypedDate(text) !== null) setInvalid(false)
    if (date !== null) emit(e, date)
    if (controlled) setDraft({ text, base: date ?? current })
    syncValidity(e.target)
  }

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const date = settle(e)
    onBlur?.(retargetEvent(e, e.type, dateTarget(e.currentTarget, date)))
  }

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    if (!controlled) heardRef.current = parseTypedDate(e.currentTarget.value) ?? ""
    onFocus?.(e)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") settle(e)
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    if (e.key === "F4" || (e.altKey && e.key === "ArrowDown")) {
      e.preventDefault()
      openCalendar()
    }
  }

  /** A day chosen in the calendar (or the calendar cleared). */
  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const node = fieldRef.current
    if (!node) return
    const date = e.target.value
    setInvalid(false)
    if (controlled) setDraft(null)
    else node.value = date
    if (date !== heard()) emit(e, date)
    syncValidity(node)
  }

  return (
    <span className={cn("relative block w-full", box)}>
      <input
        autoComplete="off"
        spellCheck={false}
        // A shrink-to-fit field (w-fit) stays about as wide as the native date input was.
        size={12}
        placeholder={placeholder ?? t("date_placeholder")}
        {...props}
        {...(controlled ? { value: typing ?? current } : { defaultValue })}
        ref={setRefs}
        type="text"
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={showInvalid ? true : ariaInvalid}
        onChange={handleChange}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        className={cn(FIELD_CLASS, FIELD_LINE_CLASS, field, "pr-8")}
      />
      <input
        ref={calendarRef}
        type="date"
        form={DETACHED_FORM}
        tabIndex={-1}
        aria-hidden="true"
        min={min}
        max={max}
        onChange={handlePick}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        tabIndex={-1}
        aria-label={t("date_open_calendar")}
        disabled={disabled || readOnly}
        // Keeps the focus in the text field; the click focuses it and opens the calendar.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          fieldRef.current?.focus()
          openCalendar()
        }}
        className="absolute right-0.5 top-1/2 -translate-y-1/2"
      >
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
      </Button>
    </span>
  )
})

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, onWheel, ...props }, ref) => {
    // Prevent the mouse wheel from silently mutating a focused number input
    // (e.g. scrolling the page over a salary field turning 20000 into 19998).
    // Blurring drops focus so the wheel scrolls the page instead of the value.
    const handleWheel = React.useCallback(
      (e: React.WheelEvent<HTMLInputElement>) => {
        if (type === 'number') {
          e.currentTarget.blur()
        }
        onWheel?.(e)
      },
      [type, onWheel]
    )

    if (type === "date") return <DateInput ref={ref} className={className} onWheel={onWheel} {...props} />

    return (
      <input
        type={type}
        className={cn(
          FIELD_CLASS,
          FIELD_LINE_CLASS,
          "items-center file:border-0 file:bg-transparent file:text-[13px] file:font-medium",
          className
        )}
        ref={ref}
        onWheel={handleWheel}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
