# Swedish E-Invoicing Market, Providers and Pricing

This reference covers (a) which Access Points and service providers operate in Sweden, (b) how the dominant Swedish accounting platforms (Fortnox, Visma, Bokio, SpeedLedger, Björn Lundén, Hogia) wire their Peppol layers, almost all white-label, (c) per-document pricing benchmarks, (d) the post-2022 industry consolidation pattern.

## Major Swedish Access Points and service providers

| Provider | Status (Apr 2026) | Segment | Reach (claimed) | Notes |
|---|---|---|---|---|
| **Pagero** | Acquired by **Thomson Reuters Feb 2024** (~SEK 8.1B / USD 800M); now branded "ONESOURCE Pagero" | Large enterprise / global multinationals + free SME tier | 90,000 customers, 14M-company network, 75+ countries | Net sales 2023 SEK 795M (+33%); EBITA −SEK 17.4M. REST APIs (Document/Network/Signup/File/User). Quote-based pricing. Strong in global tax compliance. |
| **InExchange (Factorum AB)** | **Visma group since ~2020**, Skövde HQ | SME / mid-market dominant | ~80M tx/yr, 60,000 customers, 800,000+ orgs | Underlying operator for **Visma Autoinvoice** and Hantverksdata Entré. 12 invoices/yr free tier. Heaviest installed Swedish SME base. |
| **Crediflow AB** | PE-backed by **VIA Equity (2024)**; group includes OptoSweden, DocUp | Mid-market, ERP/system partner | 300,000+ companies monthly via 60+ ERPs | **Underlying AP for Fortnox, Bokio, SpeedLedger.** Group revenue ~SEK 100M. Most Swedish SaaS accounting depends on Crediflow. |
| **Visma Autoinvoice / Maventa** | Visma Group (KKR/HG/Cinven) | Captive Visma ecosystem | Routes through Maventa AP + InExchange | Cross-border via Peppol BIS 3; converts Svefaktura 1.0, TEAPPSXML, Finvoice 3.0, VismaXML, LiinosXML, SI-UBL. **API documentation:** https://documentation.autoinvoice.visma.com/ |
| **Tietoevry (BIX)** | Listed Finnish-Swedish | Banks, large enterprise, public sector | Certified Peppol AP since 2012 | White-labels to two of the largest Swedish banks. Strong B2C (Multichannel/Live Invoice). |
| **Basware** | **Take-private 2022** by Accel-KKR + Long Path + Briarwood (€620M, 94.7% premium) | Large global enterprise AP automation | 700+ global customers, 170M invoices/yr | HQ Helsinki/Espoo. Strong with Hogia. |
| **OpusCapita** | Acquired by **GEP (US) 1 July 2024** from PSG Equity | Mid/large enterprise, Nordics | 600 clients | Operates Skatteverket's free supplier portal. |
| **Ropo Capital** | Adelis Equity-backed; acquired Colligent Inkasso (2019), Posti Messaging Scandinavia (2020) | Large invoice volumes (energy, real estate, telco) | 11,000+ Nordic customers, 170M+ docs/yr | Combines invoicing + collections. |
| **Qvalia** | Swedish, Stockholm | SME, developer-friendly | 30+ countries, ISO 27001 | **Public, transparent EUR pricing** (see below). Best DX choice for an open-source integration. |
| **Hogia** | Swedish | Enterprise | Own Peppol AP | **Only major SE accounting vendor with its own Peppol AP** (others white-label). Uses Basware fakturaadresser for some units. |
| **Compello, Edicom, TrueCommerce, Tungsten Automation** | Various | Niche / enterprise / EDI |, | Minor Sweden footprint relative to top tier. |
| **Storecove** | Dutch | Developer-first, multi-mandate API | 30+ countries | Single REST API spans Peppol + DBNAlliance + local mandates (FR, IT SDI, BE, DE, PL KSeF, etc.). 30-day free sandbox. Strong fit for ERP/SaaS embedding. |

## Qvalia public pricing (EUR, as of April 2026)

| Tier | Monthly EUR | Messages/mo |
|---|---|---|
| Free | €0 | 1 |
| Small | €9 | 25 |
| Medium | €39 | 100 |
| Plus | €99 | 1,000 |
| Plus | €249 | 2,500 |
| Plus | €499 | 5,000 |
| Plus | €899 | 10,000+ |

Setup fee 0. Includes inbound + outbound Peppol BIS Billing 3 + EHF + multi-mandate routing. **Most transparent commercial pricing in the Swedish market**, useful as a benchmark.

## SME pricing benchmarks (April 2026)

| Item | Typical SME price (SEK) |
|---|---|
| Outbound e-invoice (sender) | **3.00-3.50** (Bokio, SpeedLedger, BL); 0-3.40 (InExchange) |
| Inbound e-invoice | Often free; 3.50 (BL) |
| Monthly minimum (SME platform) | 0-199 |
| Setup/onboarding | 0 |
| Postal fallback | 8.25-20 |
| Kivra to consumer | ~5 |
| Enterprise (Pagero/Basware) per-doc | Negotiated, EUR 0.10-0.50 |

## How Swedish accounting platforms wire Peppol

**The dominant SME accounting platforms in Sweden all white-label two intermediaries.** Fortnox, Bokio and SpeedLedger funnel through **Crediflow**. Visma eEkonomi/SPCS/Administration/Business funnel through **Visma Autoinvoice (Maventa)**, which is itself a certified Peppol AP. None operate their own Peppol AP, except Hogia.

This concentration is a strategic opening for any new platform: **building native Peppol disintermediates the entire value chain** and removes a markup baked into incumbent pricing.

### Fortnox

- Sweden's largest cloud ERP (~500,000+ customers).
- REST API at `https://api.fortnox.se/3/` (XML or JSON).
- Rate limit 25 req/5s/token.
- OAuth2 via `https://apps.fortnox.se/oauth-v1/`.
- Key endpoints: `/3/invoices`, `/3/supplierinvoices`, `/3/supplierinvoicepayments`, `/3/invoicepayments`, `/3/supplierinvoicefileconnections` (attach UBL/PDF), `/3/supplierinvoiceaccruals`, `/3/customers`, `/3/suppliers`, `/3/articles`, `/3/vouchers`, `/3/accounts`, `/3/financialyears`, `/3/taxreductions` (ROT/RUT), `/3/noxfinansinvoices` (factoring).
- WebSocket push API delivers `Invoices`/`SupplierInvoices`/`Vouchers`/`Customers` topics.
- Peppol-ID auto-published in Peppol Directory for AB customers.
- ROT/RUT housework supported natively (`HouseWork=true`, `HouseWorkType`, `HouseWorkHoursToReport`).

### Visma Autoinvoice / Maventa

- Cleanest Peppol developer story among Swedish platforms.
- API docs: https://documentation.autoinvoice.visma.com/
- REST and legacy SOAP, OAuth2 client-credentials.
- Operator routing flags: `PEPPOL`, `INEXCHANGE`, `NEMHANDEL`, `SCAN`, `BANK`, `B2CSE`, `VISMASCANNER`.
- The `lookup`/`finder` endpoint exposes SMP discovery.
- `POST /v1/services/b2cse/agreement` registers a sender on the Swedish bank-based B2C rail (e-faktura privat).

### Bokio

- Outbound UBL Peppol BIS Billing 3 at **3 SEK per invoice** via Crediflow.
- **B2B only** for outbound Peppol.
- Auto-flags year-end-crossing invoices.
- Provides "Konvertera till fakturametoden" UX, useful template for any Swedish bookkeeping product.

### Björn Lundén (BL Total / Lundify)

- **3.50 SEK per outbound and inbound** e-invoice.

### SpeedLedger

- Bank-feed centric.
- **3 SEK per sent**.

### Hogia

- The only major SE accounting vendor with its own Peppol AP.
- Owns relationships with several mid-market customers.

## Industry consolidation post-2022

Pattern: **bigger players are bundling tax + invoicing + AP automation + compliance reporting for enterprise**, leaving the Swedish SME and redovisningsbyrå segment as fertile ground.

| Year | Event |
|---|---|
| 2022 | Basware take-private by Accel-KKR + Long Path + Briarwood, €620M, 94.7% premium |
| Feb 2024 | Thomson Reuters acquires Pagero, ~SEK 8.1B / USD 800M |
| 2024 | VIA Equity acquires Crediflow group |
| 1 Jul 2024 | GEP (US) acquires OpusCapita from PSG Equity |
| ~2020 | Visma Group acquires InExchange (Factorum AB) |
| 2019-2020 | Ropo Capital acquires Colligent Inkasso, Posti Messaging Scandinavia |

**Reseller dependency risk is now real**, Pagero is a TR division, Basware is PE-owned, both will eventually re-price upward. Build optionality into the stack via a clean `SendClient` abstraction with dual-vendor capability.

## Choosing an Access Point partner, decision framework

For a new Swedish accounting/fintech product, the practical menu:

1. **Storecove**, best DX, single API across Peppol + IT SDI + FR PA + PL KSeF + BE + DE. Free 30-day sandbox. Effective rate €0.05-€0.30/invoice. **Best fit when multi-mandate is needed.**
2. **Qvalia**, transparent EUR pricing, ISO 27001, Swedish-headquartered. Good fit for SME-only Swedish flows.
3. **InExchange**, heaviest Swedish installed base, but partial vendor lock-in via Visma Group ownership.
4. **Visma Autoinvoice / Maventa**, only worth it if already integrating Visma ecosystem.
5. **Pagero / Basware**, enterprise-only, not SME-friendly post-acquisition.
6. **Own Oxalis-NG AP**, only for receive at low volume (€100/mo Hetzner + €4,400 yr-1 OpenPeppol fees). For send, only economic above ~25k invoices/month.

**Build vs buy break-even:** reseller cost of ~€0.10/invoice (mid-volume Storecove) versus own-AP fixed cost of ~€30k/year (membership + cert + ops) breaks even at **~300,000 invoices/year sent through your customers**, equivalent to ~3,000-5,000 active SME customers each sending 50-100 invoices/month. **For receive there is no economic case to build initially**, Storecove free receive or own Oxalis on a small VPS dominate.

## Authoritative source list

- DIGG Peppol traffic stats: https://www.digg.se/digitala-tjanster/peppol/statistik-fran-peppolnatverket-
- Visma Autoinvoice docs: https://documentation.autoinvoice.visma.com/
- Fortnox API: https://developer.fortnox.se/
- Pagero compliance pages: https://www.pagero.com/compliance/regulatory-updates/sweden
- Storecove blog/docs: https://www.storecove.com
- Qvalia pricing: https://qvalia.com/pricing/
- InExchange knowledge base: https://inexchange.com/en/discover
- Skatteverket on B2G e-faktura: https://skatteverket.se/omoss/varverksamhet/forleverantorer/efakturortillskatteverket.4.b1014b415f3321c0de2680.html