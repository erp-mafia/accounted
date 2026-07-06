# Cross-Framework Mapping: NIST 800-53, CIS Controls, SOC 2

A single ISO 27001 finding can be projected onto NIST SP 800-53 Rev. 5, CIS Controls v8.1, and SOC 2 Trust Services Criteria. Embedding these mappings into the scanner's data model lets a single scan produce dual- or quad-compliance reports.

## Why these three

| Framework | Purpose | Audit type | Best paired with ISO 27001 when |
|---|---|---|---|
| NIST SP 800-53 Rev. 5 | U.S. federal control catalog (highly prescriptive, granular) | Self-assessment / FedRAMP | Selling to U.S. government / FedRAMP authorization. |
| CIS Controls v8.1 | Prioritized, technical implementation roadmap | Operational benchmark | Used as the technical companion to ISO's governance focus. |
| SOC 2 Trust Services Criteria | Operational effectiveness attestation | Type I (point-in-time) or Type II (period) | Selling SaaS to U.S. enterprise customers. |

ISO 27001 is governance-first; CIS is technique-first; NIST is exhaustive-first; SOC 2 is operational-effectiveness-first. They overlap heavily but are not interchangeable.

## ISO 27001:2022 → NIST SP 800-53 Rev. 5

The official NIST mapping uses an asterisk convention: an unmarked mapping means full equivalence; an asterisk means the ISO control does not fully satisfy the NIST control's intent.

| ISO 2022 ID | NIST Control(s) | Equivalence |
|---|---|---|
| A.5.1 (Policies) | PL-1, PM-1 | Full |
| A.5.2 (Roles) | PS-2, AC-1 | Full |
| A.5.7 (Threat Intelligence) | PM-15, PM-16, RA-3, SI-5 | Partial: NIST is more prescriptive on TI sources |
| A.5.9 (Inventory) | CM-8, PM-5 | Partial: NIST CM-8 demands more frequent reconciliation |
| A.5.15 (Access control) | AC-1, AC-2, AC-3, AC-5, AC-6 | Full |
| A.5.23 (Cloud security) | SA-9 (External system services), CA-3 | Partial |
| A.5.30 (BC readiness) | CP-2, CP-7, CP-10 | Full |
| A.5.34 (Privacy / PII) | PT-1 through PT-8 (Privacy family) | **Significant gap: see below** |
| A.6.1 (Screening) | PS-3 | Full |
| A.6.3 (Awareness) | AT-1, AT-2 | Full |
| A.7.1 (Physical perimeter) | PE-3 | Full |
| A.7.4 (Physical monitoring) | PE-6 | Full |
| A.8.2 (Privileged access) | AC-6 (Least privilege) | Full |
| A.8.3 (Information access restriction) | AC-3 | Full |
| A.8.4 (Source code access) | CM-5, AC-3 | Full |
| A.8.8 (Vulnerability management) | RA-5, SI-2 | Full |
| A.8.9 (Configuration management) | CM-2, CM-3, CM-6 | Full |
| A.8.10 (Information deletion) | MP-6, SI-12 | Full |
| A.8.11 (Data masking) | SC-28, SI-19 | Partial |
| A.8.12 (DLP) | SC-7 (Boundary protection), SC-8 | Partial |
| A.8.15 (Logging) | AU-2, AU-3, AU-12 | Full |
| A.8.16 (Monitoring) | AU-6, SI-4 | Full |
| A.8.20 (Network security) | SC-7, SC-8 | Full |
| A.8.22 (Network segregation) | SC-7(13), SC-32 | Full |
| A.8.24 (Cryptography) | SC-13, SC-28, IA-7 | Full |
| A.8.25 (Secure SDLC) | SA-3, SA-15 | Full |
| A.8.28 (Secure coding) | SA-11, SI-10 | Full |
| A.8.32 (Change management) | CM-3, CM-4 | Full |

### Critical NIST gap: privacy

NIST SP 800-53 Rev. 5 integrates a full Privacy (PT) control family directly into the catalog. ISO 27001 addresses privacy primarily through A.5.34 and points to ISO 27701 for full privacy management. Organizations claiming dual ISO 27001 + NIST 800-53 compliance must either:
1. Adopt ISO 27701 in addition, OR
2. Implement the NIST PT family separately and document this as a SoA inclusion above and beyond Annex A.

The scanner should explicitly flag NIST PT family as a documentation gap when generating dual-compliance reports based solely on ISO 27001.

---

## ISO 27001:2022 → CIS Controls v8.1

CIS Controls are organized into 18 numbered controls (formerly "Critical Security Controls"). They are the most operationally prescriptive of the four frameworks.

| ISO 2022 | CIS Control | Notes |
|---|---|---|
| A.5.9 (Inventory of assets) | CIS 1 (Enterprise Assets), CIS 2 (Software Assets) | CIS provides the technical methodology. |
| A.8.10, A.8.11, A.8.12 (Data lifecycle) | CIS 3 (Data Protection) | Direct alignment. |
| A.8.9 (Configuration management) | CIS 4 (Secure Configuration) | Direct alignment. |
| A.5.15, A.8.2 (Access control) | CIS 5 (Account Management), CIS 6 (Access Control Management) | Split across two CIS controls. |
| A.8.8 (Vulnerability management) | CIS 7 (Continuous Vulnerability Management) | Direct alignment. |
| A.8.15 (Logging) | CIS 8 (Audit Log Management) | Direct alignment. |
| A.8.7 (Malware protection) | CIS 10 (Malware Defenses) | Direct alignment. |
| A.8.13 (Backup) | CIS 11 (Data Recovery) | Direct alignment. |
| A.8.20, A.8.22 (Network security) | CIS 12 (Network Infrastructure Management), CIS 13 (Network Monitoring) | Split. |
| A.6.3 (Awareness training) | CIS 14 (Security Awareness and Skills Training) | Direct alignment. |
| A.5.21, A.8.30 (Supply chain) | CIS 15 (Service Provider Management) | Direct alignment. |
| A.8.25, A.8.28 (SDLC, secure coding) | CIS 16 (Application Software Security) | Direct alignment. |
| A.5.24-28 (Incident management) | CIS 17 (Incident Response Management) | Direct alignment. |
| A.8.29 (Security testing) | CIS 18 (Penetration Testing) | Direct alignment. |

CIS Controls have three Implementation Groups (IG1, IG2, IG3) of increasing rigor. The scanner should report which IG level each in-scope CIS control reaches based on detected configurations.

---

## ISO 27001:2022 → SOC 2 Trust Services Criteria

SOC 2 has five categories. Security (Common Criteria, CC) is mandatory for every SOC 2 report; the others are optional based on the service's commitments.

| TSC Category | When to include |
|---|---|
| Security (CC1-CC9) | Always. |
| Availability | If uptime is part of customer commitments. |
| Processing Integrity | If accuracy/completeness of processing matters (e.g., financial systems). |
| Confidentiality | If protecting non-personal confidential data (trade secrets, customer business data). |
| Privacy | If processing personal information. |

### ISO → SOC 2 Common Criteria mapping

| ISO 2022 | SOC 2 CC | Notes |
|---|---|---|
| A.5.1 (Policies) | CC1.1, CC2.2 | Control environment foundation. |
| Clause 5 (Leadership) | CC1.1, CC1.2, CC1.3 | Tone at the top. |
| A.5.2 (Roles) | CC1.4, CC1.5 | Accountability. |
| A.5.4 (Management responsibilities) | CC2.1, CC2.2 | Communication. |
| Clause 6.1 (Risk) | CC3.1, CC3.2, CC3.3, CC3.4 | Risk assessment. |
| Clause 9 (Performance evaluation) | CC4.1, CC4.2 | Monitoring. |
| A.5.1, Clause 5.2 | CC5.1, CC5.2, CC5.3 | Control activities. |
| A.5.15, A.5.16, A.8.2, A.8.3, A.8.5 | CC6.1, CC6.2, CC6.3 | Logical access. |
| A.7.1-A.7.14 | CC6.4, CC6.5 | Physical access. |
| A.8.10 | CC6.5 | Information disposal. |
| A.8.24 | CC6.6, CC6.7, CC6.8 | Data protection in transit and at rest. |
| A.8.15, A.8.16 | CC7.1, CC7.2 | System operations. |
| A.5.24-A.5.28 | CC7.3, CC7.4, CC7.5 | Incident response. |
| A.8.32 | CC8.1 | Change management. |
| Clause 10 (Improvement), A.5.21 | CC9.1, CC9.2 | Risk mitigation, vendor management. |

### Dual-report generation

When generating a SOC 2 + ISO 27001 dual report, the scanner should:

1. Run the ISO 27001 scan as primary.
2. Project each finding onto the corresponding SOC 2 CC.
3. Highlight ISO controls that have **no SOC 2 equivalent** (rare, but exists for some governance-heavy A.5 controls).
4. Highlight SOC 2 CCs that are **only partially covered** by ISO controls (e.g., processing integrity and privacy categories require additional evidence).

---

## Implementation in scanner data model

Each finding object should carry a `framework_mappings` field:

```json
{
  "finding_id": "F-001",
  "iso_27001_2022": ["A.8.24"],
  "nist_800_53_r5": ["SC-13", "SC-28"],
  "cis_v8_1": ["3.11"],
  "soc_2_tsc": ["CC6.6", "CC6.7"],
  "severity": "high",
  "title": "EBS volume not encrypted at rest"
}
```

This allows the same finding to appear in four different report views without re-running the scan.

## Caveats

- Mappings are bidirectional but lossy. ISO is governance-heavy; NIST is technical-heavy; CIS is implementation-heavy; SOC 2 is operational-effectiveness-heavy. Different frameworks emphasize different aspects of the same underlying risk.
- An organization passing one framework does not automatically pass another. Each framework has unique requirements (NIST privacy family, SOC 2 processing integrity, etc.).
- Mappings change between framework versions. Verify the version (ISO 27001:2022, NIST 800-53 Rev. 5, CIS v8.1, SOC 2 2017 TSC) every time. The skill should refuse to map without explicit version assertions.
