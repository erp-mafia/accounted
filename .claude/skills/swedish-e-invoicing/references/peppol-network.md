# Peppol Network Architecture, AS4, SMP, SML, PKI

## The four-corner model

Standard Peppol routing:

```
[C1 Sender]  →  [C2 Sending AP]  →  [C3 Receiving AP]  →  [C4 Receiver]
   ERP                                                       ERP
                          ─── Peppol network ───
```

Only **C2↔C3** is on-network. C1↔C2 and C3↔C4 are local integrations (REST API, SFTP, file watcher, ERP plugin) chosen by each AP. Sending and receiving APs may belong to different organisations or to the same provider; they may also be the same AP (intra-network delivery).

ViDA introduces the **five-corner model** for cross-border B2B reporting from 1 July 2030: the tax administration becomes Corner 5 receiving DRR data in parallel with C3.

## SML, Service Metadata Locator

The SML is the centralised DNS service. Operated by **OpenPeppol AISBL** (insourced from EC DG DIGIT during 2024-2025).

Lookup algorithm (migrated from CNAME/MD5 to **NAPTR/SHA-256** during 2025):

```
domain = base32(sha-256(lowercase(<scheme>::<value>))).iso6523-actorid-upis.<DNSZONE>
```

Production zone: `edelivery.tech.ec.europa.eu`
Test zone: `acc.edelivery.tech.ec.europa.eu`

DNS NAPTR record returns the SMP base URL.

Example for DIGG (`0007:2021006883`):

```
sha256("iso6523-actorid-upis::0007:2021006883") = ...
base32(hash) = b-eepvcndgxw5tjr...
NAPTR query: b-eepvcndgxw5tjr....iso6523-actorid-upis.edelivery.tech.ec.europa.eu
```

## SMP, Service Metadata Publisher

The SMP is queried per **Peppol SMP specification v1.3.0 (February 2025)** for `ServiceGroup` (lists of supported document types) and `SignedServiceMetadata` (specific endpoint metadata, signed XML-DSIG). Endpoints expose:

- `GET /<participant-id>`, ServiceGroup (list of document types).
- `GET /<participant-id>/services/<doc-type-id>`, SignedServiceMetadata (endpoint URL, AP certificate, transport profile, validity period).

Transport profile is now **`peppol-transport-as4-v2_0`** for production (replaced the v1 profile in 2020).

A given participant can be registered with **only one SMP at a time**. Migrating between APs requires the new AP to register the participant in its SMP and the old AP to deregister.

## AS4 transport

**Peppol AS4 Profile v2.0.x** is a profile of CEF eDelivery AS4 v1.14, which is itself a profile of OASIS ebMS3.

Wire characteristics:
- HTTPS, TLS 1.2+ (TLS 1.3 supported).
- MIME multipart with single encrypted payload.
- WS-Security message-level signing (RSA-SHA256) using the sender's AP certificate.
- Encryption (AES-128-GCM or AES-256-GCM) using the recipient AP's certificate fetched from the SMP.
- Single payload per AS4 message wrapping the **SBDH (Standard Business Document Header) v1.2** / **Peppol Business Message Envelope 2.0** which itself wraps the UBL document.

**SBDH C1 country code mandatory since January 2024.** Oxalis 6.2.0+, Helger phase4 latest, and other compliant stacks enforce this. The SBDH carries `Sender`, `Receiver`, `DocumentIdentification` (standard, type version, instance ID), `BusinessScope` (process ID, document type ID, **C1 country code**).

**From 1 February 2026**, SMP servers must run HTTPS on port 443 under the Peppol Policy for Transport Security.

Authoritative spec: https://docs.peppol.eu/edelivery/as4/specification/

## PKI, G2 to G3 migration

The Peppol PKI migrated from **G2 (issued by IHC) to G3 (DigiCert One Trust Lifecycle)** during H2 2025. **G3-only after end-2025**, any test/production cert issued from 2026 onwards is G3.

Two certificate types per Access Point:
- **AP cert**, used for AS4 message signing and encryption.
- **SMP cert**, used to sign `SignedServiceMetadata` responses.

Cert validity is typically 1-2 years. Renewal is automated via DigiCert's portal; trust store updates flow via OpenPeppol member announcements.

Trust store libraries (Helger `peppol-commons`, Oxalis) ship the bundled Peppol root and intermediate certs; update at least quarterly to track CA rotation.

Issuance and enrolment process: https://openpeppol.atlassian.net/wiki/spaces/OPMA/pages/4439080961/Peppol+PKI+2025+-+Issuing+and+Enrolment+Process

## Identifier schemes (ICD / EAS codes)

Used as `schemeID` on `cbc:EndpointID`, `cac:PartyIdentification/cbc:ID`, etc.

| Code | Authority | Use |
|---|---|---|
| **0007** | Bolagsverket organisationsnummer | Swedish primary |
| **0088** | GS1 GLN | Swedish large orgs; recommended for sole proprietors (GDPR) |
| **0192** | Norwegian Enhetsregisteret | Replaces deprecated `9908` |
| **0184** | Danish CVR | Danish primary |
| **0037** | Finnish LY-tunnus | Finnish primary |
| **0208** | Belgian KBO/BCE | Belgian primary |
| **0204** | German Leitweg-ID | German B2G mandatory |
| **9930** | German VAT-ID | German B2B |
| **0009** | French SIRET | French primary |
| **0211** | Italian CodiceIPA | Italian B2G |
| **0213** | Italian CodiceFiscale | Italian B2C |
| **0096** | Dutch OIN | Dutch government |

Authoritative live list: https://docs.peppol.eu/edelivery/codelists/ and https://docs.peppol.eu/poacc/billing/3.0/codelist/eas/.

GitHub: https://github.com/OpenPEPPOL/peppol-bis-invoice-3/blob/master/structure/codelist/eas.xml

## Becoming a Peppol Access Point, the operational path

### OpenPeppol membership fees (effective 1 July 2025 for new members)

For a small Swedish fintech (S1 size, 1-10 employees):

| Path | Sign-up | Annual | Certification | Year-1 total |
|---|---|---|---|---|
| **AP + SMP S1** | €1,800 | €2,750 | €2,500 | **≈ €7,050** |
| **AP-only S1+S2** | €1,050 | €1,850 | €1,500 | **≈ €4,400** |
| **End User S1+S2** | €650 | €1,250 | n/a | **≈ €1,900** |

Add infrastructure cost: 24/7 redundant AS4 hosting (€3-10k/yr), monitoring/on-call (€5-20k fully loaded), DigiCert G3 certs (bundled into OpenPeppol annual). DIGG charges no additional Peppol-Authority fee for Swedish service providers but requires signing the **Peppol Service Provider Agreement**.

**Realistic minimum to operate an own AP: €20-40k/year direct cost plus 0.5-1 FTE engineering and 3-6 months upfront build.** Twice-yearly spec updates with a 7-day implementation window and mandatory monthly volume reporting are non-trivial recurring costs.

### Onboarding steps

1. Submit candidate application to `membership@peppol.eu`.
2. Sign the **Peppol Member Agreement** with OpenPeppol AISBL.
3. Sign the **Peppol Service Provider Agreement** (formerly Transport Infrastructure Agreement, TIA) with **DIGG** as Sweden's Peppol Authority.
4. Implement AS4 + SMP lookup + SBDH handling. Deploy in test environment.
5. Request DigiCert One G3 test certificate.
6. Pass the **Peppol Testbed conformance suite**, refactored 2025 with country-specific payload tests. https://peppol.org/tools-support/testbed/
7. Pay the Certification Fee.
8. Production certificate issued.
9. Register SMP in production SML via DIGG.
10. Commit to monthly volume reporting.

**Total elapsed time: 3-6 months.**

### Open-source AS4 / SMP stacks

- **Oxalis-NG** (https://github.com/OxalisCommunity/oxalis-ng), replaces Oxalis 6.x which is end-of-life Dec 2025. Java, Apache 2.0.
- **Oxalis-AS4 7.x** (https://github.com/OxalisCommunity/oxalis-as4).
- **Helger phase4** (https://github.com/phax/phase4), Apache 2.0 AS4 client + server.
- **Helger phoss-smp**, production-grade SMP server.
- **Helger peppol-commons**, identifiers, codelists, SBDH, SMP/SML clients.
- **Helger phive + phive-rules**, validation engine and pre-built rules.
- **Helger ph-ubl, ph-cii, ph-sbdh**, JAXB models.
- **phase4-peppol-standalone**, Spring Boot 3 reference implementation (template, not turn-key).

Trust stores updated to G3-only late 2025. Verify version when integrating.

## DIGG Peppol traffic statistics (Q4 2025)

- October 2025: record **5,668,209 Peppol messages** to Sweden.
- November 2025: 4,810,015.
- December 2025: 5,190,513.
- Volume growth Sept 2024 → Sept 2025: **+30%**.
- **25,000+ Swedish Peppol receivers** registered.
- DIGG public sector survey (March 2025): 82% of public sector inbound invoices are e-invoices, 50% of outbound (up from 24%), 85% of public sector orgs use Peppol fully/largely for inbound.
- Bankföreningen reports 168.9M e-invoices to consumers in 2024.
- Total Swedish e-invoice volume estimate: **~250M/year** combining bank rails, Peppol B2G/B2B, and residual non-Peppol flows.

Live stats: https://www.digg.se/digitala-tjanster/peppol/statistik-fran-peppolnatverket-

## Authoritative source list

- Peppol AS4 spec: https://docs.peppol.eu/edelivery/as4/specification/
- Peppol SMP spec: https://docs.peppol.eu/edelivery/smp/specification/
- SMP/SML interplay (Helger): https://peppol.helger.com/public/menuitem-docs-smp-sml-interplay
- Setup AP guide: https://peppol.helger.com/public/menuitem-docs-setup-ap
- Setup phoss SMP: https://peppol.helger.com/public/menuitem-docs-setup-smp-ph
- Peppol Testbed: https://peppol.org/tools-support/testbed/
- OpenPeppol membership: https://peppol.eu/who-is-who/openpeppol-membership/
- DIGG how Peppol works: https://www.digg.se/digitala-tjanster/peppol/sa-fungerar-peppol-
- Identifier policy: https://docs.peppol.eu/edelivery/codelists/