import { redirect } from 'next/navigation'

// The extensions list lives on /extensions; this URL only keeps old links working.
export default function SectorExtensionsPage() {
  redirect('/extensions')
}
