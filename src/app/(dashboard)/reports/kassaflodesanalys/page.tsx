import { KassaflodesanalysClient } from './KassaflodesanalysClient'

// NOTE: This page offers no Excel download yet. Plan item #4 (Excel export
// for all reports) introduces a shared `reportToWorkbook` helper and adds
// `/api/reports/kassaflodesanalys/xlsx`; add the download beside the PDF one
// in the top bar once that lands, rather than a disabled placeholder.

export default function KassaflodesanalysPage() {
  return <KassaflodesanalysClient />
}
