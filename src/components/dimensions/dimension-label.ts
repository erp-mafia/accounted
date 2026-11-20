import type { DimensionDto } from '@/components/dimensions/types'

/**
 * The label of a SIE dimension number on a tagged line: its registry name,
 * for the system pair (1 Kostnadsställe, 6 Projekt, never renamed) and
 * custom dimensions alike, so a dimension reads the same on every surface.
 * 'Dim N' while the registry loads, or for a number it does not hold (tags
 * written while dimensions were off are not checked against the registry).
 */
export function dimensionDisplayName(
  registry: ReadonlyArray<Pick<DimensionDto, 'sie_dim_no' | 'name'>> | null | undefined,
  sieDimNo: string | number,
): string {
  const dimNo = String(sieDimNo)
  return registry?.find((d) => String(d.sie_dim_no) === dimNo)?.name ?? `Dim ${dimNo}`
}
