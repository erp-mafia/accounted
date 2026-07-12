'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import QRCode from 'qrcode'

interface BankIdQrCodeProps {
  qrStartToken: string
  qrStartSecret: string
}

/**
 * Animated BankID QR code component.
 * Computes HMAC-SHA256 every second per BankID spec:
 *   bankid.{qrStartToken}.{time}.{hmac_sha256(qrStartSecret, time)}
 */
export function BankIdQrCode({ qrStartToken, qrStartSecret }: BankIdQrCodeProps) {
  const [svgData, setSvgData] = useState<string>('')
  const elapsedRef = useRef(0)
  const tokenRef = useRef(qrStartToken)
  const secretRef = useRef(qrStartSecret)

  // Update refs when tokens change (order regeneration)
  useEffect(() => {
    tokenRef.current = qrStartToken
    secretRef.current = qrStartSecret
    elapsedRef.current = 0
  }, [qrStartToken, qrStartSecret])

  const generateQr = useCallback(async () => {
    const token = tokenRef.current
    const secret = secretRef.current
    const time = elapsedRef.current

    try {
      // Compute HMAC-SHA256 using Web Crypto API
      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      )
      const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(time.toString()))
      const qrAuthCode = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      const qrData = `bankid.${token}.${time}.${qrAuthCode}`

      const svg = await QRCode.toString(qrData, {
        type: 'svg',
        margin: 1,
        width: 200,
        color: { dark: '#141414', light: '#ffffff' },
      })
      setSvgData(svg)
    } catch {
      // Silently fail: next tick will retry
    }

    elapsedRef.current++
  }, [])

  useEffect(() => {
    // Generate immediately, then every second
    generateQr()
    const interval = setInterval(generateQr, 1000)
    return () => clearInterval(interval)
  }, [generateQr])

  if (!svgData) {
    return (
      <div className="flex h-[200px] w-[200px] items-center justify-center rounded-lg border bg-white">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div
      className="inline-flex rounded-lg border bg-white p-2"
      dangerouslySetInnerHTML={{ __html: svgData }}
    />
  )
}
