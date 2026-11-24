import type { BankIdDevice } from '@/components/bankid/autostart'

/** The two BankID ways in the signing flow offers in its own screen. */
export type BankIdSigningWay = 'same_device' | 'qr'

/**
 * The way in offered first (the filled button) on this device. A phone
 * carries the BankID app and cannot scan a QR on its own screen: BankID på
 * den här enheten leads, the QR (a BankID on another phone) follows. A
 * computer leads with the QR, scanned with the phone.
 */
export function leadingSigningMethod(device: Pick<BankIdDevice, 'mobile'>): BankIdSigningWay {
  return device.mobile ? 'same_device' : 'qr'
}

/** The way in offered second (the outline button) on this device. */
export function otherSigningMethod(device: Pick<BankIdDevice, 'mobile'>): BankIdSigningWay {
  return leadingSigningMethod(device) === 'qr' ? 'same_device' : 'qr'
}

/**
 * The signing a dialog starts as it opens, with no tap (autoStart): the QR
 * on a computer. Nothing on a phone: the dialog opens on the method step,
 * where the person's own tap starts BankID on this device. A BankID app link
 * opened after an awaited start has no tap behind it, and mobile browsers
 * then refuse it (components/bankid/autostart), so the app opens from the
 * link the waiting step renders.
 */
export function autoStartSigningMethod(device: Pick<BankIdDevice, 'mobile'>): BankIdSigningWay | null {
  return device.mobile ? null : 'qr'
}
