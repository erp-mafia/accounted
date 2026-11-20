import { LikviditetsprognosView } from '@/components/reports/LikviditetsprognosView'

/**
 * Likviditetsprognos (accounted#136): the 13-week liquidity forecast. Not a
 * period report, so it owns its route like the kassaflödesanalys and starts
 * today; the report catalog links here.
 */
export default function LikviditetsprognosPage() {
  return <LikviditetsprognosView />
}
