import { recipientsFor } from '@/lib/legal/subprocessors'
import { LegalTable } from './LegalShell'

/**
 * The recipient list from lib/legal/subprocessors.ts. The DPA view lists
 * sub-processors of the customer's bookkeeping data; the privacy view lists
 * the processors behind what we are controller for. One source, two views.
 */
export function RecipientTable({ view }: { view: 'dpa' | 'privacy' }) {
  const rows = recipientsFor(view).map((r) => [
    r.name,
    <>
      {r.purpose}
      <br />
      <span className="text-muted-foreground">Uppgifter: {r.data}</span>
      {r.activation && (
        <>
          <br />
          <span className="text-muted-foreground">{r.activation}</span>
        </>
      )}
    </>,
    r.location,
    r.safeguard,
  ])
  return (
    <LegalTable
      head={[view === 'dpa' ? 'Underbiträde' : 'Mottagare', 'Ändamål och uppgifter', 'Plats', 'Skydd']}
      rows={rows}
    />
  )
}
