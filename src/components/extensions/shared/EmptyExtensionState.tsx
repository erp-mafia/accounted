'use client'

import { PuzzlePieceIcon, type Icon } from '@/components/icons'
import { EmptyState } from '@/components/ui/empty-state'

interface EmptyExtensionStateProps {
  title?: string
  description?: string
  icon?: Icon
}

/** An extension with nothing to show: the shared state block (Stil v3), in place of the first row. */
export default function EmptyExtensionState({
  title = 'Ingen data ännu',
  description = 'Data kommer att visas här när det finns tillgängligt.',
  icon = PuzzlePieceIcon,
}: EmptyExtensionStateProps) {
  return <EmptyState icon={icon} title={title} description={description} />
}
