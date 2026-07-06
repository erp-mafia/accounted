# 2013 → 2022 Control Mapping

When scanning legacy repositories or evaluating SoAs that still reference 2013-era control identifiers, translate using this matrix before generating findings. Failing to translate produces false-positive non-conformities.

## Structural change

| Aspect | 2013 | 2022 |
|---|---|---|
| Control count | 114 | 93 |
| Domains/themes | 14 domains (A.5-A.18) | 4 themes (A.5-A.8) |
| Attribute system | None | 5 attribute dimensions per control |
| Merged controls | N/A | 57 → 24 |
| New controls | N/A | 11 net-new |
| Retained (renamed/renumbered) | N/A | 58 |

## Common translation patterns

The 2013 controls A.5-A.18 do not map cleanly to A.5-A.8. The new themes are reorganized around governance level, not topical similarity to the old domains.

| 2013 ID | 2013 Title | 2022 ID | 2022 Title | Notes |
|---|---|---|---|---|
| A.5.1.1 | Policies for information security | A.5.1 | Policies for information security | Direct rename. |
| A.6.1.1 | Information security roles and responsibilities | A.5.2 | Information security roles and responsibilities | Direct rename. |
| A.6.1.2 | Segregation of duties | A.5.3 | Segregation of duties | Direct rename. |
| A.6.1.3 | Contact with authorities | A.5.5 | Contact with authorities | Direct rename. |
| A.6.1.4 | Contact with special interest groups | A.5.6 | Contact with special interest groups | Direct rename. |
| A.6.2 | Mobile devices and teleworking | A.6.7, A.8.1 | Remote working / User endpoint devices | Split. |
| A.7 | Human resource security (entire domain) | A.6 | People (entire theme) | Restructured. |
| A.8.1.1 | Inventory of assets | A.5.9 | Inventory of information and other associated assets | Renamed, broader. |
| A.8.2 | Information classification | A.5.12, A.5.13 | Classification of information / Labelling | Split into two. |
| A.9 | Access control (entire domain) | A.5.15-A.5.18, A.8.2-A.8.5 | Distributed across themes | Major restructure. |
| A.9.1.1 | Access control policy | A.5.15 | Access control | Merged. |
| A.9.2.1 | User registration and de-registration | A.5.16 | Identity management | Renamed. |
| A.9.2.3 | Management of privileged access rights | A.8.2 | Privileged access rights | Renamed. |
| A.9.4.5 | Access control to program source code | A.8.4 | Access to source code | Renamed. |
| A.10 | Cryptography | A.8.24 | Use of cryptography | Compressed. |
| A.10.1.1 | Policy on the use of cryptographic controls | A.8.24 | Use of cryptography | Merged. |
| A.10.1.2 | Key management | A.8.24 | Use of cryptography | Merged. |
| A.11 | Physical and environmental security | A.7 | Physical (entire theme) | Restructured. |
| A.12.1.1 | Documented operating procedures | A.5.37 | Documented operating procedures | Moved to Organizational. |
| A.12.1.2 | Change management | A.8.32 | Change management | Renumbered. |
| A.12.1.3 | Capacity management | A.8.6 | Capacity management | Renumbered. |
| A.12.1.4 | Separation of development, testing and operational environments | A.8.31 | Separation of development, test and production environments | Renumbered. |
| A.12.2.1 | Controls against malware | A.8.7 | Protection against malware | Renamed. |
| A.12.3.1 | Information backup | A.8.13 | Information backup | Direct rename. |
| A.12.4.1 | Event logging | A.8.15 | Logging | Compressed (4 controls into 1). |
| A.12.4.2 | Protection of log information | A.8.15 | Logging | Merged. |
| A.12.4.3 | Administrator and operator logs | A.8.15 | Logging | Merged. |
| A.12.4.4 | Clock synchronisation | A.8.17 | Clock synchronization | Renumbered. |
| A.12.5.1 | Installation of software on operational systems | A.8.19 | Installation of software on operational systems | Renumbered. |
| A.12.6.1 | Management of technical vulnerabilities | A.8.8 | Management of technical vulnerabilities | Renumbered. |
| A.12.6.2 | Restrictions on software installation | A.8.19 | Installation of software on operational systems | Merged. |
| A.13.1.1 | Network controls | A.8.20 | Network security | Renamed. |
| A.13.1.2 | Security of network services | A.8.21 | Security of network services | Renumbered. |
| A.13.1.3 | Segregation in networks | A.8.22 | Segregation of networks | Renumbered. |
| A.13.2 | Information transfer | A.5.14 | Information transfer | Moved to Organizational. |
| A.14.1 | Security requirements of information systems | A.8.26 | Application security requirements | Compressed. |
| A.14.2.1 | Secure development policy | A.8.25 | Secure development life cycle | **Frequently referenced legacy ID.** |
| A.14.2.2 | System change control procedures | A.8.32 | Change management | Merged. |
| A.14.2.5 | Secure system engineering principles | A.8.27 | Secure system architecture and engineering principles | Renamed. |
| A.14.2.7 | Outsourced development | A.8.30 | Outsourced development | Renumbered. |
| A.14.2.8 | System security testing | A.8.29 | Security testing in development and acceptance | Renamed. |
| A.14.3.1 | Protection of test data | A.8.33 | Test information | Renamed. |
| A.15 | Supplier relationships | A.5.19-A.5.22 | Supplier-related controls | Restructured into Organizational. |
| A.16 | Information security incident management | A.5.24-A.5.28 | Incident-related controls | Restructured. |
| A.17 | Information security aspects of business continuity | A.5.29, A.5.30, A.8.13, A.8.14 | Distributed | Restructured. |
| A.18.1 | Compliance with legal and contractual requirements | A.5.31 | Legal, statutory, regulatory and contractual requirements | Compressed. |
| A.18.1.3 | Protection of records | A.5.33 | Protection of records | Renumbered. |
| A.18.1.4 | Privacy and protection of PII | A.5.34 | Privacy and protection of PII | Renumbered. |
| A.18.2.1 | Independent review of information security | A.5.35 | Independent review of information security | Renumbered. |

## Implementation note for the scanner

When parsing a SoA that uses 2013 identifiers:

1. Detect the format (heuristic: presence of identifiers like A.9.x, A.12.x, A.14.x indicates 2013).
2. Apply the translation table above.
3. Generate a warning: "SoA references 2013-era identifiers. Translation applied. Recommend updating SoA to 2022 identifiers."
4. Run all checks against translated 2022 controls.
5. Verify the 11 net-new controls (see `new-controls-2022.md`) are now addressed in the SoA: they will not have legacy equivalents.

The translation is one-way and lossy. Several 2013 controls map to multiple 2022 controls (splits) and several 2022 controls absorb multiple 2013 controls (merges). When in doubt, apply the most restrictive interpretation.
