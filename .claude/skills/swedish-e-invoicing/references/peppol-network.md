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

## Becoming a Peppol Service Provider, the operational path

There is no Peppol licence to buy. Three things, in this order: OpenPeppol membership,
Testbed certification, then the **Peppol Service Provider Agreement** (v4.0.2, approved
28 May 2025) signed by the national Peppol Authority. The authority signs only after
certification passes.

### Sweden's Peppol Authority is Upphandlingsmyndigheten

**Since 1 July 2026, not DIGG.** Contact **peppol@uhmynd.se**. They book an introductory
digital meeting before anything is signed. OpenPeppol's own Sweden country profile page is
stale and still names Digg; do not route people there.

The authority charges nothing. SP Agreement clause 14.3: "The Peppol Authority cannot
charge the Peppol Service Providers or End Users for connecting to or using the Peppol
Network." Each party bears its own costs (14.1). All the money goes to OpenPeppol.

### OpenPeppol membership fees (effective 1 July 2025 for new members)

For a small Swedish fintech (S1 size, 1-10 employees):

| Path | Sign-up | Annual | Certification | Year-1 total |
|---|---|---|---|---|
| **AP + SMP S1** | €1,800 | €2,750 | €2,500 | **≈ €7,050** |
| **AP-only S1+S2** | €1,050 | €1,850 | €1,500 | **≈ €4,400** |
| **SMP-only S1+S2** | €1,050 | €5,000 | €1,000 | **≈ €7,050** |
| **End User S1+S2** | €650 | €1,250 | n/a | **≈ €1,900** |

The certification fee is charged once at first certification, then folds into the annual
fee. The annual fee is pro-rata for the remainder of the calendar year on joining.

**AP-only is a trap for a SaaS vendor.** A participant can be registered in exactly one SMP
at a time, so AP-only leaves every customer registration and every customer migration
dependent on another provider's SMP. Adding SMP later costs a second certification.

Add infrastructure cost: 24/7 redundant AS4 hosting (€3-10k/yr), monitoring/on-call
(€5-20k fully loaded), DigiCert G3 certs (bundled into OpenPeppol annual).

**Realistic minimum to operate an own AP: €20-40k/year direct cost plus 0.5-1 FTE
engineering and 3-6 months upfront build**, before ISO 27001. Twice-yearly spec updates
with a 7-day implementation window and mandatory monthly reporting are non-trivial
recurring costs.

### ISO/IEC 27001 is mandatory from 1 July 2027

Every Peppol Service Provider must hold a valid ISO/IEC 27001 certificate from **1 July
2027**. OpenPeppol milestones: 30 June 2026 equivalence requests for other certificates,
**1 September 2026** submit certificates already held, **1 October 2026** submit evidence
of an ongoing certification project, 1 February 2027 and 1 May 2027 progress reports,
1 July 2027 hard deadline.

The Statement of Applicability must explicitly cover Access Point, Service Metadata
Publisher, End User Identification, document management, integrity controls, logging and
audit trail, backup and business continuity. Scope that omits Peppol operations does not
count.

For a company of 1-10 people, budget 200-500 kSEK to first certificate plus recurring
surveillance audits. This, not AS4, is the real barrier to entry.

### Onboarding steps

1. Mail the Peppol Authority (**peppol@uhmynd.se** in Sweden) and book the intro meeting.
2. Apply to `membership@peppol.eu` for **Candidate Service Provider** status in the chosen
   category (AP+SMP, AP-only or SMP-only).
3. Return the signed **Peppol Member Agreement** plus company registration documents.
   OpenPeppol runs due diligence: registration, solvency and criminal checks.
4. Pay sign-up plus pro-rata annual fee. Join the eDelivery Community and at least one
   other Domain Community (Post-Award for invoicing).
5. Request **PKI test certificates** (DigiCert One G3) via the Peppol Service Desk. A
   signed member form is sufficient; the SP Agreement is not required yet, so the build
   can run fully in parallel with the authority track.
6. Implement AS4 + SMP + SBDH handling. Deploy to test, SML `acc.edelivery.tech.ec.europa.eu`.
7. Pass the eDelivery test suite at https://www.testbed.peppol.org (client-cert auth).
8. Download the test report, request the **production** PKI certificate. OpenPeppol's
   Operating Office evaluates it; a positive result is required before production.
9. The Peppol Authority signs the Service Provider Agreement.
10. Register in the production SML, go live, begin monthly reporting.

**Total elapsed time: 3-6 months.**

### What the Testbed actually tests

Six AP test cases, run one at a time, re-runnable as often as needed:

1. **TLS grading verification**, must be Qualys SSL Labs **grade A or above**
2. AS4 message reception (static config, no SMP registration needed)
3. AS4 message submission (send a Testbed-supplied artifact unmodified)
4. Invalid certificate handling
5. Large AS4 message reception
6. Large AS4 message submission

Prerequisites: PKI v3 AP test certificate imported into the browser **and** configured on
the AP itself, HTTPS-only endpoint, a CA chain trusted by both Microsoft and Oracle trust
stores. Self-signed certificates are rejected outright.

The technical bar is modest. The organisational obligations below are where the cost is.

### What the SP Agreement binds you to (v4.0.2)

Clauses that change product design, not just paperwork:

- **9.2 End user identification.** A contract with every end user (directly, or indirectly
  through an intermediary), identity verified at onboarding per the Entity Identification
  rules, and the contract must state the user will be blocked on fraud, spam or criminal
  acts. Upphandlingsmyndigheten lists a working *kundkännedomsprocess* as a standing
  obligation. **For a self-serve SaaS this is the largest gap: instant signup is not
  compatible with it.**
- **9.3** Membership must be maintained for the life of the agreement.
- **9.4.2** Log every send and receive, retain per law and never under 3 months,
  disclosable on reasonable request.
- **9.4.5** Publish an incident contact (e-mail and phone) and respond to incidents.
- **9.4.9** Meet the domain minimum service levels and scale if capacity is short. The
  exact figures live in the member-only Internal Regulations. The widely quoted "99.5%,
  24/7, service windows under 2 hours announced 3 days ahead, retry 3 times within 2
  hours" comes from the Norwegian enhanced-network AP requirements, not from OpenPeppol's
  general post-award rules. Confirm the binding numbers before publishing an SLA.
- **9.7** The authority can order you to block an end user. That switch must exist.
- **15 Subcontracting is permitted**, and 9.2 allows the end user relationship to run
  "indirectly through an intermediary". This is the clause the entire white-label and
  reseller market rests on, and the fallback if the AP track stalls.
- **16** You may not collect or expose dataset content or metadata beyond what operating
  the network requires or the end user instructs. Peppol traffic is not analytics or
  training material.
- **18 Penalties** escalate: publication on the member site, publication on the public
  site, temporary removal from the network, permanent removal. Five working days to supply
  a remediation plan after a warning note.
- **19.3 Liability** capped at €500,000 per event and €1,000,000 per year, except wilful
  acts or gross negligence.
- **22** Six months' notice to terminate; immediate on unremedied breach after 60 days,
  insolvency or security failure; **automatic if OpenPeppol membership lapses**.

### Mandatory reporting

Monthly, both required of every Service Provider:

- **TSR** (Transaction Statistics Reporting): per document type, plus which other Access
  Points you exchanged with. Raw data is derivable from the transport protocol and SBDH.
- **EUSR** (End User Statistics Reporting): number of end users served, per document type.

Specs: https://docs.peppol.eu/edelivery/specs/reporting/tsr/bis/ and
https://docs.peppol.eu/edelivery/specs/reporting/eusr/bis/

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

## Swedish Peppol traffic statistics (Q4 2025, published by DIGG before the handover)

- October 2025: record **5,668,209 Peppol messages** to Sweden.
- November 2025: 4,810,015.
- December 2025: 5,190,513.
- Volume growth Sept 2024 → Sept 2025: **+30%**.
- **25,000+ Swedish Peppol receivers** registered.
- Public sector survey (DIGG, March 2025): 82% of public sector inbound invoices are e-invoices, 50% of outbound (up from 24%), 85% of public sector orgs use Peppol fully/largely for inbound.
- Bankföreningen reports 168.9M e-invoices to consumers in 2024.
- Total Swedish e-invoice volume estimate: **~250M/year** combining bank rails, Peppol B2G/B2B, and residual non-Peppol flows.

Live stats: https://www.upphandlingsmyndigheten.se/digitalisering-och-e-handel/peppol/statistik-fran-peppolnatverket/

## Authoritative source list

- Peppol AS4 spec: https://docs.peppol.eu/edelivery/as4/specification/
- Peppol SMP spec: https://docs.peppol.eu/edelivery/smp/specification/
- SMP/SML interplay (Helger): https://peppol.helger.com/public/menuitem-docs-smp-sml-interplay
- Setup AP guide: https://peppol.helger.com/public/menuitem-docs-setup-ap
- Setup phoss SMP: https://peppol.helger.com/public/menuitem-docs-setup-smp-ph
- Peppol Testbed: https://peppol.org/tools-support/testbed/
- OpenPeppol membership and fees: https://peppol.org/join/ and https://peppol.org/join/fees/
- Peppol SP Agreement v4.0.2: https://peppol.agid.gov.it/attachments/PeppolServiceProviderAgreement_v4.0.2_AGID_update_final.pdf
- Test and Onboarding guide v1.4: https://peppol.org/wp-content/uploads/2024/03/Peppol_TestbedAndOnboarding_v1.4.pdf
- Swedish Peppol Authority (blivande Service Provider): https://www.upphandlingsmyndigheten.se/digitalisering-och-e-handel/peppol/peppol-for-blivande-service-provider/
- How Peppol works (Upphandlingsmyndigheten): https://www.upphandlingsmyndigheten.se/digitalisering-och-e-handel/peppol/sa-fungerar-peppol/
- Identifier policy: https://docs.peppol.eu/edelivery/codelists/