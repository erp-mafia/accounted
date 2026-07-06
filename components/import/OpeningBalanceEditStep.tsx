'use client'

import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { ParsedOpeningBalanceRow } from '@/lib/import/opening-balance/types'
import OpeningBalanceRowEditor, {
  type EditableRow,
  type OpeningBalanceEditorState,
} from './OpeningBalanceRowEditor'

interface OpeningBalanceEditStepProps {
  rows: ParsedOpeningBalanceRow[]
  onContinue: (rows: EditableRow[]) => void
  onBack: () => void
}

let idCounter = 0
function generateId() {
  return `row_${++idCounter}_${Date.now()}`
}

export default function OpeningBalanceEditStep({
  rows: initialRows,
  onContinue,
  onBack,
}: OpeningBalanceEditStepProps) {
  const seedRows = useMemo<EditableRow[]>(
    () =>
      initialRows.map((r) => ({
        id: generateId(),
        account_number: r.account_number,
        account_name: r.account_name,
        debit_amount: r.debit_amount,
        credit_amount: r.credit_amount,
        validation_errors: [...r.validation_errors],
        bas_match: r.bas_match,
      })),
    [initialRows],
  )
  const [state, setState] = useState<OpeningBalanceEditorState | null>(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Granska och redigera</CardTitle>
        <CardDescription>
          Kontrollera att kontonummer och belopp stämmer. Du kan lägga till, ta bort och ändra
          rader. Debet och kredit måste balansera innan du kan fortsätta.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <OpeningBalanceRowEditor initialRows={seedRows} onChange={setState} />

        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack}>
            Tillbaka
          </Button>
          <Button onClick={() => state && onContinue(state.rows)} disabled={!state?.canSubmit}>
            Fortsätt
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
