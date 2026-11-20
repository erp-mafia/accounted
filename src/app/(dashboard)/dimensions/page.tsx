import DimensionsManager from '@/components/dimensions/DimensionsManager'

/**
 * Dimensioner (the dimension registry): a Redovisning-group register peer
 * to Kontoplan. Reference/configuration surface: manage the dimensions
 * (#DIM) and the values (#OBJEKT) that voucher lines are tagged with.
 * Reachable only via the nav row when company_settings.dimensions_enabled
 * is on, but the page itself never gates: the toggle is UI visibility, not
 * correctness (dimensions plan §2).
 */
export default function DimensionsPage() {
  // The manager owns the page chrome (top bar with the primary), since the
  // primary needs the client state of the active dimension.
  return <DimensionsManager />
}
