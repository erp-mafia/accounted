'use client'

import type { CollectionsStage } from '@accounted/connect-contract'
import { Badge } from '@/components/ui/badge'
import { CHIP_LABEL_KEYS, CHIP_VARIANTS, collectionChipKind } from '@/lib/collections/stages'
import { useCaseWords } from './case-client'

/**
 * The chip an open collection case puts on its invoice, in the list and in
 * the invoice header: "Skickad via {provider}", "Påminnelse", "Hos
 * inkasso", "Väntar på ditt beslut", "Pausad". Chips mark exceptions
 * (convention 5): an invoice with a case is one. Nothing for a closed case.
 */
export function CollectionChip({
  stage,
  displayName,
  className,
}: {
  stage: CollectionsStage
  displayName: string | null
  className?: string
}) {
  const { tp } = useCaseWords(displayName)
  const kind = collectionChipKind(stage)
  if (!kind) return null
  return (
    <Badge variant={CHIP_VARIANTS[kind]} className={className}>
      {tp(CHIP_LABEL_KEYS[kind])}
    </Badge>
  )
}
