import { Folder } from './Folder'
import { FlowSymbol } from './FlowSymbol'
import { AnalysisSymbol } from './AnalysisSymbol'
import type { ItemKind } from './hues'

/**
 * An item's picture by what it is: a flow runs step by step, so it shows its steps;
 * knowledge is information, so it rests in a folder; an analysis is a figure, so it shows its bars.
 */
export function ItemSymbol({ kind, hue, size, open = false }: { kind: ItemKind; hue: number; seedKey?: string; size: number; open?: boolean }) {
  if (kind === 'workflow') return <FlowSymbol hue={hue} size={size} />
  if (kind === 'analysis') return <AnalysisSymbol hue={hue} size={size} />
  return <Folder hue={hue} size={size} open={open} drift={open} />
}
