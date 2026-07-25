# DPIA screening: invoice delivery history

Classification: Confidential

Date: 2026-07-22
Updated: 2026-07-24 (provider delivery outcome)
Owner: Accounted controller
Status: Screening completed

## Processing

The service records each customer-invoice delivery attempt, its recipient and
message payload, delivery result, and the exact attached PDF. The purpose is to
provide operational delivery history and evidence that accounting information
was sent. The lawful bases are contract performance under GDPR Article 6(1)(b)
and legal obligations under Article 6(1)(c) and BFL 7 kap.

## Necessity and proportionality

The exact payload is needed server-side to resolve delivery disputes and retain
the sent accounting document. It is not necessary in the routine browser list.
The list therefore exposes only status, timestamps, masked recipient domains,
provider name, the provider delivery outcome with its masked reason text, error
code, and an active-company-scoped link to the archived PDF. Subjects, bodies,
full addresses, reply-to addresses, provider message IDs, BCC recipients,
filenames, and checksums are excluded.

The provider delivery outcome (`provider_status`, `provider_status_at`,
`provider_status_detail`) is received from the email provider over a signed
webhook after the send. The outcome and its timestamp are delivery metadata.
The reason text is provider-authored and routinely quotes the recipient address
that failed, so it is treated as recipient personal data: local parts are masked
before it leaves the server, the stored text is capped at 500 characters, and it
is cleared by the same daily redaction job as the rest of the delivery PII. No
open or click tracking is enabled, so no recipient behaviour is recorded.

The owner/admin full statutory archive has a different legal and operational
purpose from the routine list, so it intentionally does not apply the list's
field minimization to `data/invoice_deliveries.json`. That export contains the
delivery and tenant identifiers, actor identifier, channel and status, full To,
CC, and BCC recipient arrays, reply-to and sender name, subject, plain-text and
HTML bodies, provider and provider message identifier, error code, archived
document identifier, attachment filename, content type and SHA-256 checksum,
delivery timestamps, retention and redaction timestamps, and creation time. The
ZIP may also contain the exact sent PDF and other company accounting records.
Access is therefore restricted to owner/admin and returned only as a private
server-generated export.

## Risks and controls

- Cross-tenant disclosure: route context, explicit `company_id` filters, RLS,
  active-company document authorization, and a second owner/admin membership
  verification through the stateless service-role client before export. Every
  service-role archive query uses the verified `company_id` directly or IDs
  derived from rows scoped to that company.
- Excess browser disclosure: allow-listed response fields, domain masking, and
  `private, no-store` caching. BCC recipients never leave the server-side
  delivery evidence through the list endpoint. The exact table payload is
  sender-only under RLS; other members use a masked summary function. Complete
  statutory exports are owner/admin-only server operations. Their exact payload
  exception is limited to the downloadable statutory archive purpose described
  above and is not reused by the routine history endpoint.
  The summary function is defined in migration `20260724160000` and the route
  applies domain masking again before returning its allow-listed fields,
  including inside the provider reason text.
- Forged delivery outcome: the provider webhook is Svix-signature verified
  before anything is written, and the applying function is service-role only.
  It matches on the provider's own message identifier, may only touch an
  already sent, unredacted row, and can never downgrade an observed failure.
- Forged delivery evidence: authenticated PostgREST INSERT and UPDATE access is
  removed. Server-only functions bind reservations and state transitions to a
  verified writable company member. Payload-free crashed reservations may be
  reclaimed by another sender only after 15 minutes.
- Undocumented mutation: immutable status transitions plus a metadata-only
  audit trigger. Audit state excludes recipients and message content.
- Excess retention: fiscal-period-derived `retention_expires_at` and daily PII
  redaction after the statutory minimum expires.
- Misleading failed evidence: a provider failure detaches and deletes the
  unsent archived PDF while retaining attempt metadata.

## Screening conclusion

The processing is limited to ordinary invoice contact and communication data,
does not involve systematic monitoring, special-category data, automated legal
decisions, or large-scale combination of datasets. With the controls above it
does not meet the GDPR Article 35 high-risk threshold, so a full DPIA is not
required. Re-screen before adding message search, analytics, special-category
content, or cross-customer profiling.
