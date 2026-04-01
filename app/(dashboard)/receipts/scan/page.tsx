'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function ScanReceiptPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/receipts')
  }, [router])

  return null
}
