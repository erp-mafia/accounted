export const MAX_INVOICE_EMAIL_RECIPIENTS = 20
export const MAX_INVOICE_EMAIL_COPY_RECIPIENTS = MAX_INVOICE_EMAIL_RECIPIENTS - 1
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface ResolveInvoiceEmailRecipientsInput {
  to: string | readonly string[]
  configuredCc?: readonly string[] | null
  configuredBcc?: readonly string[] | null
  customerCc?: readonly string[] | null
  customerBcc?: readonly string[] | null
  legacyCc?: string | null
  additionalCc?: readonly string[]
  additionalBcc?: readonly string[]
}

export interface ResolvedInvoiceEmailRecipients {
  to: string[]
  cc: string[]
  bcc: string[]
}

export function invoiceEmailRecipientCount(
  recipients: ResolvedInvoiceEmailRecipients,
): number {
  return recipients.to.length + recipients.cc.length + recipients.bcc.length
}

export function exceedsInvoiceEmailRecipientLimit(
  recipients: ResolvedInvoiceEmailRecipients,
): boolean {
  return invoiceEmailRecipientCount(recipients) > MAX_INVOICE_EMAIL_RECIPIENTS
}

export interface InvoiceEmailRecipientCollision {
  address: string
  field: 'additional_cc' | 'additional_bcc'
  conflicts_with:
    | 'to'
    | 'configured_cc'
    | 'configured_bcc'
    | 'customer_cc'
    | 'customer_bcc'
    | 'additional_cc'
    | 'additional_bcc'
}

function normalizedKey(address: string): string {
  return address.trim().toLocaleLowerCase('en-US')
}

function uniqueAddresses(
  addresses: readonly string[],
  used: Set<string>,
): string[] {
  const result: string[] = []

  for (const rawAddress of addresses) {
    const address = rawAddress.trim()
    const key = normalizedKey(address)
    if (!key || used.has(key)) continue
    used.add(key)
    result.push(address)
  }

  return result
}

/**
 * Build the exact recipient lists submitted to the email provider.
 *
 * A null company CC list means the company has never configured the new
 * setting, so the historical automatic-copy address remains in effect. An
 * explicit empty list disables that fallback. Recipients are de-duplicated
 * with To taking precedence over CC and CC taking precedence over BCC.
 */
export function resolveInvoiceEmailRecipients(
  input: ResolveInvoiceEmailRecipientsInput,
): ResolvedInvoiceEmailRecipients {
  const used = new Set<string>()
  const rawTo = typeof input.to === 'string' ? [input.to] : input.to
  const to = uniqueAddresses(rawTo, used)

  const fixedCc = input.configuredCc === null || input.configuredCc === undefined
    ? input.legacyCc
      ? [input.legacyCc]
      : []
    : input.configuredCc

  const cc = uniqueAddresses(
    [...fixedCc, ...(input.customerCc ?? []), ...(input.additionalCc ?? [])],
    used,
  )
  const bcc = uniqueAddresses(
    [
      ...(input.configuredBcc ?? []),
      ...(input.customerBcc ?? []),
      ...(input.additionalBcc ?? []),
    ],
    used,
  )

  return { to, cc, bcc }
}

/**
 * Report explicit per-send recipients that would be silently moved or omitted
 * by deterministic To, CC, BCC precedence. Company-level configuration keeps
 * its historical de-duplication behavior, while caller-supplied collisions are
 * rejected before invoice number allocation so the caller can correct them.
 */
export function findAdditionalInvoiceRecipientCollisions(
  input: ResolveInvoiceEmailRecipientsInput,
): InvoiceEmailRecipientCollision[] {
  const occupied = new Map<string, InvoiceEmailRecipientCollision['conflicts_with']>()
  const rawTo = typeof input.to === 'string' ? [input.to] : input.to
  for (const address of rawTo) {
    const key = normalizedKey(address)
    if (key) occupied.set(key, 'to')
  }

  const fixedCc = input.configuredCc === null || input.configuredCc === undefined
    ? input.legacyCc
      ? [input.legacyCc]
      : []
    : input.configuredCc
  for (const address of fixedCc) {
    const key = normalizedKey(address)
    if (key && !occupied.has(key)) occupied.set(key, 'configured_cc')
  }
  for (const address of input.customerCc ?? []) {
    const key = normalizedKey(address)
    if (key && !occupied.has(key)) occupied.set(key, 'customer_cc')
  }
  for (const address of input.configuredBcc ?? []) {
    const key = normalizedKey(address)
    if (key && !occupied.has(key)) occupied.set(key, 'configured_bcc')
  }
  for (const address of input.customerBcc ?? []) {
    const key = normalizedKey(address)
    if (key && !occupied.has(key)) occupied.set(key, 'customer_bcc')
  }

  const collisions: InvoiceEmailRecipientCollision[] = []
  for (const address of input.additionalCc ?? []) {
    const key = normalizedKey(address)
    if (!key) continue
    const conflict = occupied.get(key)
    if (conflict) {
      collisions.push({ address: address.trim(), field: 'additional_cc', conflicts_with: conflict })
      continue
    }
    occupied.set(key, 'additional_cc')
  }
  for (const address of input.additionalBcc ?? []) {
    const key = normalizedKey(address)
    if (!key) continue
    const conflict = occupied.get(key)
    if (conflict) {
      collisions.push({ address: address.trim(), field: 'additional_bcc', conflicts_with: conflict })
      continue
    }
    occupied.set(key, 'additional_bcc')
  }

  return collisions
}

export function parseInvoiceRecipientText(value: string): string[] {
  const used = new Set<string>()
  return uniqueAddresses(value.split(/[\n,;]+/), used)
}
