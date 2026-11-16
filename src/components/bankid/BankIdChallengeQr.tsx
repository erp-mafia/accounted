'use client'

import { useEffect, useState } from 'react'

/**
 * A BankID QR code from data the bank hands over. Unlike the login QR
 * (BankIdQrCode, which derives each frame from a start token and secret), a
 * bank's signing flow returns the finished QR payload on every poll, so this
 * only renders what it is given: the parent re-renders it about once a second.
 * The payload is drawn, never logged.
 */
export function BankIdChallengeQr({ data, label }: { data: string; label: string }) {
  const [svg, setSvg] = useState('')

  useEffect(() => {
    let cancelled = false
    // qrcode loads with the first frame, not with every page that can sign.
    import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toString(data, { type: 'svg', margin: 1, width: 200, color: { dark: '#141414', light: '#ffffff' } }),
      )
      .then((out) => {
        if (!cancelled) setSvg(out)
      })
      .catch(() => {
        // The next poll brings new data; a frame that failed to render is skipped.
      })
    return () => {
      cancelled = true
    }
  }, [data])

  return (
    <div
      role="img"
      aria-label={label}
      className="mx-auto h-[200px] w-[200px] rounded-lg bg-white p-1 shadow-raised"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
