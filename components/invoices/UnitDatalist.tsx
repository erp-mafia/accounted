import { UNIT_DATALIST_ID, UNIT_SUGGESTIONS } from '@/lib/invoices/units'

/**
 * The suggestion list behind every unit field. Render it once per form and
 * point the input at it with `list={UNIT_DATALIST_ID}`: the field stays free
 * text, so a unit we do not suggest is typed rather than blocked, and a unit
 * stored by the API or an import shows as itself instead of an empty control.
 */
export default function UnitDatalist() {
  return (
    <datalist id={UNIT_DATALIST_ID}>
      {UNIT_SUGGESTIONS.map((unit) => (
        <option key={unit} value={unit} />
      ))}
    </datalist>
  )
}
