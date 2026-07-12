# Cross-Framework Mapping

OSS license compliance findings are inputs to multiple security and compliance frameworks. The scanner output (SBOM, violations report, audit trail) must speak the vernacular of each framework's auditors. This reference enumerates the mappings.

## NIST 800-53 Rev. 5

National Institute of Standards and Technology Special Publication 800-53 Revision 5: security and privacy controls for federal information systems and supporting commercial infrastructure (FedRAMP, CMMC).

| Control | Name | OSS compliance mapping | Evidence artifact |
|---------|------|------------------------|-------------------|
| **CM-8** | System Component Inventory | The SBOM is the inventory of OSS components. Every build emits a versioned SPDX or CycloneDX SBOM, archived. | `sbom.spdx.json`, `sbom.cdx.json`, retained per release. |
| **CM-8(2)** | Automated Maintenance | The CI/CD-integrated scanner regenerates the SBOM on every merge to main, eliminating drift between deployed components and declared inventory. | CI pipeline logs showing SBOM generation step succeeded for every merged PR. |
| **CM-8(3)** | Automated Unauthorized Component Detection | The deny-list policy in `rules.kts` blocks unauthorized licenses (typically AGPL, SSPL in proprietary contexts). | Policy file + CI pipeline failure logs for blocked PRs. |
| **SA-8** | Security Engineering Principles | The compliance program is itself an engineering principle: deterministic checks at PR time, agentic review of ambiguous cases, audit trail for non-deterministic decisions. | Compliance program documentation. |
| **SA-15** | Development Process, Standards, and Tools | The CI/CD scanner enforces approved licenses and toolchain configuration as a deterministic gate. | Pipeline configuration showing the scanner is mandatory and not bypassable. |
| **SA-15(8)** | Reuse of Threat / Vulnerability Information | Scanner integrates with vulnerability advisories (Dependabot, OSV, GitHub Advisory) so license findings and CVE findings share the same dependency-tree resolver. | Combined SCA + license report. |
| **SI-12** | Information Management and Retention | License audit trails, NOTICE attribution files, and agentic decision logs are retained per organizational retention policy. | Retention policy documenting compliance artifact lifecycle. |
| **SI-12(1)** | Limit Personally Identifiable Information Elements | When telemetry is sent to external SCA or LLM services, scrub PII and proprietary logic. Document what leaves the boundary. | Data-flow diagram for scanner telemetry. |
| **SR-3** | Supply Chain Controls and Processes | The scanner is the implementation of supply chain controls for OSS components. | Supply chain risk management plan referencing the scanner. |
| **SR-4** | Provenance | SBOM with package coordinates, version pins, and source URLs documents OSS provenance. | SBOM. |
| **SR-11** | Component Authenticity | Verify package integrity (checksums, signatures) at scanner ingestion. | Lockfile + checksum verification step in CI. |

## CIS Critical Security Controls v8.1

Center for Internet Security Critical Security Controls v8.1: prioritized, actionable safeguards.

| Safeguard | Name | OSS compliance mapping | Evidence artifact |
|-----------|------|------------------------|-------------------|
| **2.1** | Establish and Maintain a Software Inventory | SBOM covers every OSS component, including transitive dependencies and snippet-detected fragments. | SBOM, periodic snippet-scan results. |
| **2.2** | Ensure Authorized Software is Currently Supported | Scanner flags OSS components that are deprecated, unmaintained, or running unsupported versions. | SCA report with end-of-life flags. |
| **2.3** | Address Unauthorized Software | Deny-list licenses in `rules.kts`; block PRs that introduce them. | Pipeline failure log + denied license catalog. |
| **2.5** | Allowlist Authorized Software | Curated `licenseClassifications.yml` defining acceptable licenses per distribution model. | License-classification configuration. |
| **2.6** | Allowlist Authorized Libraries | The combined ORT analyzer + curation file allowlists specific package coordinates per repository. | `.ort.yml` curations + per-repo policy. |
| **3.1** | Establish and Maintain a Data Management Process | Audit-trail retention covers OSS compliance artifacts. | Retention policy. |
| **16.4** | Establish and Manage an Inventory of Third-Party Software Components | Same as CM-8 / 2.1: the SBOM. | SBOM. |
| **16.5** | Use Up-to-Date and Trusted Third-Party Software Components | Scanner integrates with vulnerability feeds; license-and-CVE findings share dependency resolution. | Combined report. |

## ISO/IEC 27001:2022 Annex A

The 2022 revision of ISO/IEC 27001 restructured Annex A around four control themes: Organizational (5), People (6), Physical (7), Technological (8). The relevant controls for OSS license compliance:

| Control | Name | OSS compliance mapping | Evidence artifact |
|---------|------|------------------------|-------------------|
| **5.19** | Information Security in Supplier Relationships | OSS upstreams are suppliers; the policy treats them as such. | Supplier policy referencing OSS upstreams; SBOM. |
| **5.20** | Addressing Information Security Within Supplier Agreements | Outsourced development contracts require flow-down of OSS scanning to subcontracted code. | Contract template + flow-down clause. |
| **5.21** | Managing Information Security in the ICT Supply Chain | SBOM, scanner audit trail, license-change event monitoring. | SBOM + monitoring procedure. |
| **5.22** | Monitoring, Review and Change Management of Supplier Services | Scanner reruns on dependency updates; license-change events trigger review. | Continuous monitoring procedure. |
| **5.31** | Legal, Statutory, Regulatory and Contractual Requirements | License obligations are contractual requirements; the program documents how they are met. | Statement of Applicability covering OSS license obligations. |
| **5.33** | Protection of Records | OSS audit-trail records (scan outputs, agentic decisions) are retained as evidence. | Retention procedure. |
| **8.4** | Access to Source Code | Where OSS license obligations require source disclosure (GPL, AGPL, MPL), the controls allow it without compromising proprietary boundaries. | Source-disclosure procedure. |
| **8.25** | Secure Development Lifecycle | The PR-time scanner is part of the SDLC. | SDLC documentation. |
| **8.28** | Secure Coding | Scanner blocks introduction of unapproved licenses and snippets. | Pipeline configuration. |
| **8.30** | Outsourced Development | Code from agencies and contractors must be scanned before acceptance. The scanner is the acceptance gate. | Acceptance procedure + scan logs from contractor deliverables. |
| **8.32** | Change Management | Every PR is scanned; the scan is part of the change-control evidence chain. | PR-scan logs. |

## SOC 2 Trust Services Criteria

AICPA TSP Section 100 (2017, revised 2022). Relevant Common Criteria for OSS license compliance:

| Criterion | Name | OSS compliance mapping | Evidence artifact |
|-----------|------|------------------------|-------------------|
| **CC2.1** | Information Quality | The SBOM is high-quality information about software composition. | SBOM with version pins and source provenance. |
| **CC3.2** | Risk Assessment | License risk (copyleft contamination, license-change events) is part of the risk assessment. | Risk register entries for OSS license risk. |
| **CC3.4** | Risk Management Process Updates | The scanner is updated for license-change events (Redis 2024, Elastic 2024, etc.). | Change log of `licenses.json` snapshot updates. |
| **CC4.1** | Continuous Monitoring | Scanner runs on every PR + on a nightly cadence + on release. | CI pipeline configuration + scheduled-job logs. |
| **CC7.1** | Change Identification | Lockfile changes trigger scans; license-change events are detected. | Trigger configuration + alert log. |
| **CC8.1** | Change Management | Every PR is reviewed against deterministic and (where applicable) agentic license policy before merge. | PR scan results stored per merge commit. |
| **CC9.1** | Risk Mitigation Plans | Detection of high-risk licenses (SSPL, AGPL in SaaS contexts) triggers documented mitigation. | Mitigation playbook. |
| **CC9.2** | Vendor and Business Partner Management | OSS upstreams are managed as the third-party-risk-managed entities they are. License changes are vendor change events. | Vendor-management register including OSS upstreams. |

## OpenChain ISO/IEC 5230:2020

ISO/IEC 5230 is the international standard for OSS license compliance program quality. The standard is short and program-focused; the scanner is the operational arm of conformance.

Conformance requires:

| Requirement | Mapping |
|-------------|---------|
| **3.1** Written program documentation | Compliance program document referencing this skill, the scanner, and the agentic auditor. |
| **3.2** Program scope | Defined: every repository in scope, every PR scanned, every release SBOM-published. |
| **3.3** Identified personnel and roles | Designated compliance owner, legal escalation path, scanner-tooling owner. |
| **3.4** Compliance training | Onboarding includes the scanner, `.ort.yml` curation, and high-risk license recognition. |
| **3.5** Bill of Materials | SBOM in SPDX or CycloneDX, generated per release, archived. |
| **3.6** Compliance artifact procedure | Documented: SBOM generation, NOTICE bundle assembly, attribution distribution. |
| **3.7** External open source request handling | Procedure for receiving and responding to source-disclosure requests (GPL, AGPL, MPL recipients). |
| **3.8** External community contribution policy | Outbound-contribution policy (this is adjacent to but distinct from inbound license compliance). |
| **3.9** Internal compliance program review | Periodic internal audit of program effectiveness. |

OpenChain conformance is an attestation, not a certification, but it is the de facto contract-level standard for OSS compliance maturity. Major customers and acquirers increasingly request OpenChain conformance attestation in supplier qualification.

## Cross-mapping at a glance

For a single OSS compliance finding, the mapping into framework vernacular:

* **Detected unapproved AGPL dependency in proprietary SaaS repository, blocked at PR time, audit trail retained.**
  * NIST 800-53: CM-8(3) (automated unauthorized component detection), SA-15 (development process tools), SR-3 (supply chain controls).
  * CIS v8.1: 2.3 (address unauthorized software), 2.6 (allowlist authorized libraries).
  * ISO 27001:2022 Annex A: 5.21 (ICT supply chain), 8.28 (secure coding), 8.32 (change management).
  * SOC 2 TSC: CC8.1 (change management), CC9.1 (risk mitigation), CC9.2 (vendor management).
  * OpenChain ISO/IEC 5230: 3.5 (BOM), 3.6 (compliance artifact procedure).

This is the kind of multi-framework crosswalk that a single PR-time scan can produce, given the right reporting layer. Build the reporter to emit the framework annotations alongside the raw violation, and a single scanner run feeds every audit downstream.
