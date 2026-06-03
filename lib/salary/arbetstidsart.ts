/**
 * SCB arbetstidsart (skiftform) codes for the SLP lönestrukturstatistik.
 *
 * Per SCB's instruction (section 15), arbetstidsart is only reported for
 * arbetsställen within gruv- och tillverkningsindustrin; the company's blankett
 * states whether it must be filled in. The seven valid codes:
 */
export interface ArbetstidsartOption {
  code: string
  label: string
}

export const ARBETSTIDSART_OPTIONS: ArbetstidsartOption[] = [
  { code: '1', label: 'Dagarbete' },
  { code: '2', label: 'Tvåskift' },
  { code: '3', label: 'Intermittent/diskontinuerligt treskift' },
  { code: '4', label: 'Kontinuerligt treskift' },
  { code: '5', label: 'Underjordsarbete' },
  { code: '6', label: 'Ständigt nattskift' },
  { code: '7', label: 'Övriga skiftformer' },
]
