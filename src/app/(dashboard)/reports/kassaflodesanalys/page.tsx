import { KassaflodesanalysClient } from './KassaflodesanalysClient'

// NOTE: The xlsx download button on this page is intentionally disabled.
// Plan item #4 (Excel export for all reports) introduces a shared
// `reportToWorkbook` helper and adds `/api/reports/kassaflodesanalys/xlsx`.
// Once that helper lands, enable the button and point it at that endpoint.

export default function KassaflodesanalysPage() {
  return <KassaflodesanalysClient />
}
