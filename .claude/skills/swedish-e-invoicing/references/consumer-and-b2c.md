# Consumer E-Faktura Ecosystem (B2C)

The B2C side of Swedish e-invoicing **runs on completely different rails from Peppol** and must be implemented separately. This reference covers Bankgirot's e-faktura privat, Kivra digital mailbox, Min Myndighetspost, and how a Swedish accounting/fintech product should approach B2C invoicing.

## Bankgirot e-faktura privat, the bank rail

E-faktura privat distributes invoices directly into Swedish individuals' internet bank inboxes. **Volume hit a record 168.9 million e-invoices to private individuals in 2024** (Bankföreningen).

### Connection process

Senders connect via **Anslutningsärende** (Standard or Express track) using the **EFA / e-giroformat**. Recipients identify themselves through **Anmälningsärende** in their own bank, selecting which senders to receive from.

Bank "license" fees ~1,000 SEK/yr per bank. Transaction fees per document negotiated.

### Bank participants

All major Swedish banks participate:

- Swedbank
- Handelsbanken
- Nordea
- SEB
- Länsförsäkringar Bank
- ICA Banken
- SBAB
- Danske Bank
- Skandia
- Sparbankerna (the network of independent savings banks)

### Volume trajectory

| Year | Volume |
|---|---|
| 2009 | 35M |
| 2010 | 60M |
| 2022 | 160M |
| **2024** | **168.9M** |

Growth has flattened as Kivra has captured incremental volume.

## Kivra, the digital mailbox

Kivra is the **de facto digital mailbox in Sweden**. Numbers (April 2026):

- **6+ million users** (~70% of Swedish adults).
- 50,000+ corporate senders.
- **532+ million dispatches in 2024**.
- 99% open rate.
- 200,000+ companies and associations as recipients.

### Ownership

41an Invest (Karl-Johan Persson + Stefan Krook), FAM, with SEB minority.

### Capabilities

- Invoice delivery + storage.
- Tink-based PISP payments and Swish integration (one-tap pay from inbox).
- Receipts, contracts, official mail.
- Per-document pricing typically **3-5 SEK**.

### API integration

Kivra exposes a REST API for tenant senders. Visma Autoinvoice exposes Kivra-routing via its `B2CSE` service flag, viable shortcut for early product launches.

## Min Myndighetspost

DIGG-operated digital mailbox for government communications. Significantly lower adoption than Kivra. Mostly used for tax-related correspondence. Not a primary channel for commercial invoicing.

## Consumer rails vs Peppol, the architectural distinction

| Dimension | Peppol (B2B/B2G) | Bank rails / Kivra (B2C) |
|---|---|---|
| Format | UBL 2.1 (EN 16931) | EFA / e-giroformat / proprietary JSON |
| Identifier | Peppol-ID (orgnr) | Personnummer / bank account |
| Routing | SMP/SML/AS4 | Bank backend / Kivra API |
| Onboarding | Recipient publishes in SMP | Recipient consents in their bank/Kivra |
| Discovery | Peppol Directory | Bank-side recipient lookup or Kivra API |
| Payment | OCR/Bankgiro/Plusgiro/IBAN | One-tap from bank/Kivra (Swish/PISP) |
| Cost per doc | 3-3.50 SEK | 3-5 SEK (Kivra), 1-3 SEK (bank) |

## Bankgirot and Plusgirot, ownership

- **Bankgirot** (BGC, founded 1959) is jointly owned by SEB, Swedbank, Handelsbanken, Danske Bank, Nordea, Länsförsäkringar Bank and SkandiaBanken.
- **Plusgirot** is owned by Nordea (acquired 2002 from Posten). A Plusgiro number is a real Nordea bank account, unlike Bankgiro which is alias-routing.
- Both joined Bankgirot membership in 2002 for interbank deposits.

## Implementation strategy for a new Swedish accounting product

To support consumer (B2C) invoicing, a Swedish accounting platform needs **two parallel integrations** beyond Peppol:

1. **Bankgirot e-faktura privat**, via a Certified Technical Distributor (CTD) or directly. CTD route is faster (no per-bank license negotiations) but adds intermediary cost.
2. **Kivra**, commercial agreement plus REST API integration. Volume-tier pricing.

**Shortcut:** **Visma Autoinvoice exposes both via its `B2CSE` service flag and Kivra-routing**. Acceptable for MVP / early launch; migrate to direct integration once volume justifies cost.

**Routing logic** the product must implement:

```
if recipient is org → Peppol BIS Billing 3
elif recipient has Kivra registered → Kivra API
elif recipient has bank e-faktura registered → Bankgirot e-faktura privat
elif recipient prefers email → PDF + email (BGC's Stora Inbetalningskortet legacy or own)
else → paper postal (8.25-20 SEK)
```

Most B2C-heavy senders end up using Kivra preferentially because of higher engagement (99% open rate), but bank e-faktura still dominates recurring/predictable invoices (utilities, telecom, mortgages).

## Authoritative source list

- Bankföreningen e-faktura statistics: https://www.bankforeningen.se
- Kivra business/sender info: https://kivra.se/foretag
- Bankgirot e-faktura privat: https://www.bankgirot.se/tjanster/e-faktura-privat/
- Min Myndighetspost: https://www.minmyndighetspost.se
- Visma Autoinvoice B2CSE flag: https://documentation.autoinvoice.visma.com/integration-guide/invoice-sending/invoice-routing/