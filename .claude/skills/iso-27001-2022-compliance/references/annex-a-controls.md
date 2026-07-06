# Annex A Controls: Full Catalog with Verification Logic

ISO/IEC 27001:2022 Annex A contains 93 controls across four themes. This file is the authoritative per-control reference. Use it to look up exact control intent and the deterministic / agentic / out-of-repo verification logic for each.

## Theme structure

| Theme | Range | Count | Primary mode |
|---|---|---|---|
| A.5 Organizational | A.5.1 to A.5.37 | 37 | Agentic |
| A.6 People | A.6.1 to A.6.8 | 8 | Out-of-repo (evidence pointers) |
| A.7 Physical | A.7.1 to A.7.14 | 14 | Out-of-repo (evidence pointers) |
| A.8 Technological | A.8.1 to A.8.34 | 34 | Deterministic |

## Control attributes (2022 addition)

Every control carries five attribute dimensions. Surface these in dashboards:

1. **Control type**: preventive, detective, corrective.
2. **Information security property**: confidentiality, integrity, availability.
3. **Cybersecurity concept**: identify, protect, detect, respond, recover.
4. **Operational capability**: governance, asset management, identity and access management, etc.
5. **Security domain**: governance and ecosystem, protection, defense, resilience.

---

## A.5 Organizational Controls (37 controls)

Primary verification mode: agentic. Most A.5 controls are evaluated by LLM review of policy artifacts. A subset has deterministic anchors (e.g., A.5.7 Threat Intelligence is deterministically anchored by the presence of an SCA tool subscription).

| ID | Title | Verification logic |
|---|---|---|
| A.5.1 | Policies for information security | Agentic: verify InfoSec_Policy.md exists, includes commitment to applicable requirements + continual improvement, signed by top management. |
| A.5.2 | Information security roles and responsibilities | Agentic: RACI matrix or equivalent in policy documents. |
| A.5.3 | Segregation of duties | Agentic + deterministic: policy text plus IAM role separation in IaC. |
| A.5.4 | Management responsibilities | Agentic: leadership commitment language in policy. |
| A.5.5 | Contact with authorities | Agentic: incident response plan references regulators (e.g., IMY for Sweden, Datainspektionen). |
| A.5.6 | Contact with special interest groups | Agentic: documented memberships (CERT, ISAC, etc.). |
| A.5.7 | Threat Intelligence (NEW 2022) | Deterministic-anchored: presence of SCA tooling (Trivy, Snyk, Dependabot) actively pulling vuln databases. |
| A.5.8 | Information security in project management | Agentic: project lifecycle docs reference security gates. |
| A.5.9 | Inventory of information and other associated assets | Deterministic: asset inventory file, CMDB reference, or IaC as the inventory source. |
| A.5.10 | Acceptable use of information and other associated assets | Agentic: AUP exists and is acknowledged. |
| A.5.11 | Return of assets | Out-of-repo: pointer to HR offboarding workflow. |
| A.5.12 | Classification of information | Agentic: classification scheme documented; deterministic spot-checks for classification mark-up in files. |
| A.5.13 | Labelling of information | Deterministic: regex check for classification labels in document headers. |
| A.5.14 | Information transfer | Agentic: transfer policy; deterministic: TLS enforcement in IaC. |
| A.5.15 | Access control | Agentic + deterministic: policy + IAM IaC + Steampipe runtime queries. |
| A.5.16 | Identity management | Deterministic: IdP integration verified via Steampipe. |
| A.5.17 | Authentication information | Deterministic: secret manager references in IaC; no hardcoded credentials. |
| A.5.18 | Access rights | Deterministic: least-privilege IAM policies; periodic access review evidence. |
| A.5.19 | Information security in supplier relationships | Agentic: supplier policy and contracts with security clauses. |
| A.5.20 | Addressing information security within supplier agreements | Agentic: DPA/security addendum templates. |
| A.5.21 | Managing information security in the ICT supply chain | Agentic + deterministic: SBOM generation in CI/CD. |
| A.5.22 | Monitoring, review and change management of supplier services | Agentic: supplier review cadence documented. |
| A.5.23 | Information security for use of cloud services (NEW 2022) | Deterministic: IaC alignment with cloud provider security baselines (CIS AWS, CIS Azure). |
| A.5.24 | Information security incident management planning and preparation | Agentic: incident response plan exists. |
| A.5.25 | Assessment and decision on information security events | Agentic: triage criteria documented. |
| A.5.26 | Response to information security incidents | Agentic: runbooks exist. |
| A.5.27 | Learning from information security incidents | Agentic: post-mortem template / blameless review process. |
| A.5.28 | Collection of evidence | Agentic: forensic procedures documented. |
| A.5.29 | Information security during disruption | Agentic: BCP exists. |
| A.5.30 | ICT readiness for business continuity (NEW 2022) | Deterministic: multi-region/multi-AZ in IaC, backup automation. |
| A.5.31 | Legal, statutory, regulatory and contractual requirements | Agentic: compliance register exists and lists applicable laws. |
| A.5.32 | Intellectual property rights | Agentic: IP policy; deterministic: license scanner output. |
| A.5.33 | Protection of records | Agentic: records retention schedule. |
| A.5.34 | Privacy and protection of PII | Agentic: privacy policy; deterministic: data masking in code (links to A.8.11). |
| A.5.35 | Independent review of information security | Agentic: internal audit log shows independent reviewers. |
| A.5.36 | Compliance with policies, rules and standards for information security | Agentic: compliance assessment reports. |
| A.5.37 | Documented operating procedures | Agentic: runbook directory exists. |

---

## A.6 People Controls (8 controls)

Primary verification mode: out-of-repo. Verify policy + evidence pointer to HRIS / LMS / ticketing system.

| ID | Title | Verification logic |
|---|---|---|
| A.6.1 | Screening | Out-of-repo: policy + pointer to HR vetting workflow. |
| A.6.2 | Terms and conditions of employment | Out-of-repo: policy + pointer to contract templates with confidentiality clauses. |
| A.6.3 | Information security awareness, education and training | Out-of-repo: policy + pointer to LMS API showing completion records. |
| A.6.4 | Disciplinary process | Out-of-repo: policy + pointer to HR escalation procedure. |
| A.6.5 | Responsibilities after termination or change of employment | Out-of-repo: policy + pointer to offboarding checklist. |
| A.6.6 | Confidentiality or non-disclosure agreements | Out-of-repo: NDA template exists in repo or pointer. |
| A.6.7 | Remote working | Agentic: remote work policy; deterministic: VPN/zero-trust enforcement in network config. |
| A.6.8 | Information security event reporting | Agentic: reporting channel documented. |

---

## A.7 Physical Controls (14 controls)

Primary verification mode: out-of-repo. Cannot be verified from repository alone. The skill verifies that the policy exists and references the system of record (facility management, badge system, environmental monitoring).

| ID | Title | Verification logic |
|---|---|---|
| A.7.1 | Physical security perimeters | Out-of-repo: policy + facility diagram pointer. |
| A.7.2 | Physical entry | Out-of-repo: policy + badge system reference. |
| A.7.3 | Securing offices, rooms and facilities | Out-of-repo: policy. |
| A.7.4 | Physical security monitoring (NEW 2022) | Out-of-repo: policy + CCTV/access log pointer. |
| A.7.5 | Protecting against physical and environmental threats | Out-of-repo: policy + insurance + environmental monitoring. |
| A.7.6 | Working in secure areas | Out-of-repo: policy. |
| A.7.7 | Clear desk and clear screen | Out-of-repo: policy + screen lock GPO/MDM enforcement. |
| A.7.8 | Equipment siting and protection | Out-of-repo: policy. |
| A.7.9 | Security of assets off-premises | Out-of-repo: laptop/mobile policy + MDM pointer. |
| A.7.10 | Storage media | Out-of-repo: media handling policy. |
| A.7.11 | Supporting utilities | Out-of-repo: UPS/HVAC documentation. |
| A.7.12 | Cabling security | Out-of-repo: facility documentation. |
| A.7.13 | Equipment maintenance | Out-of-repo: maintenance log pointer. |
| A.7.14 | Secure disposal or re-use of equipment | Out-of-repo: disposal policy + certificates of destruction pointer. |

---

## A.8 Technological Controls (34 controls)

Primary verification mode: deterministic. This is where CI/CD scanner ROI is highest.

| ID | Title | Verification logic |
|---|---|---|
| A.8.1 | User endpoint devices | Deterministic: MDM integration scripts; agentic: endpoint policy. |
| A.8.2 | Privileged access rights | Deterministic: IAM IaC scanned for wildcard `Action: "*"` / `Resource: "*"`; Steampipe runtime check for over-privileged roles. |
| A.8.3 | Information access restriction | Deterministic: RBAC middleware / route-level access control in app code. |
| A.8.4 | Access to source code | Deterministic: branch protection rules in `.github/settings.yml`, mandatory code review, no direct push to main. |
| A.8.5 | Secure authentication | Deterministic: MFA enforced in IdP config; HTTP basic auth deprecated; cookie/session security flags set. |
| A.8.6 | Capacity management | Deterministic: autoscaling group definitions, resource limits in K8s manifests. |
| A.8.7 | Protection against malware | Deterministic: endpoint protection deployment; container image vuln scanning (Trivy). |
| A.8.8 | Management of technical vulnerabilities | Deterministic: SCA executes on every PR; CVE threshold enforced. |
| A.8.9 | Configuration management (NEW 2022) | Deterministic: all infrastructure defined as code; drift detection. |
| A.8.10 | Information deletion (NEW 2022) | Deterministic: lifecycle/retention policies in storage IaC. |
| A.8.11 | Data masking (NEW 2022) | Deterministic: static analysis confirming hashing/tokenization on PII handlers. |
| A.8.12 | Data leakage prevention (NEW 2022) | Deterministic: egress filtering rules, restrictive CORS, no public buckets. |
| A.8.13 | Information backup | Deterministic: automated snapshot schedules, backup vault config. |
| A.8.14 | Redundancy of information processing facilities | Deterministic: multi-AZ / multi-region in IaC. |
| A.8.15 | Logging | Deterministic: log aggregation deployed; native cloud audit logs (CloudTrail) enabled. |
| A.8.16 | Monitoring activities (NEW 2022) | Deterministic: alerting rules + webhooks defined. |
| A.8.17 | Clock synchronization | Deterministic: NTP service uniformly configured. |
| A.8.18 | Use of privileged utility programs | Deterministic: no `--privileged` containers; agentic: utility access policy. |
| A.8.19 | Installation of software on operational systems | Deterministic: immutable infrastructure pattern enforced; CI/CD is the only path to production. |
| A.8.20 | Network security | Deterministic: TLS 1.2+ minimums, WAF deployment in load balancers. |
| A.8.21 | Security of network services | Deterministic: service definitions declare security profiles. |
| A.8.22 | Segregation of networks | Deterministic: VPC subnets, route tables, K8s NetworkPolicy enforce isolation. |
| A.8.23 | Web filtering (NEW 2022) | Deterministic: proxy / DNS firewall allow-deny lists. |
| A.8.24 | Use of cryptography | Deterministic: encryption-at-rest flags, encryption-in-transit, no MD5/SHA-1, no hardcoded keys. |
| A.8.25 | Secure development life cycle | Deterministic: Dev/Test/Prod environment isolation; security gates in pipeline. |
| A.8.26 | Application security requirements | Agentic: review of ADRs / design docs for security constraints. |
| A.8.27 | Secure system architecture and engineering principles | Agentic: review of architecture docs for zero-trust / defense-in-depth. |
| A.8.28 | Secure coding (NEW 2022) | Deterministic: SAST in CI/CD scanning OWASP Top 10. |
| A.8.29 | Security testing in development and acceptance | Deterministic: DAST + SAST mandatory pipeline steps. |
| A.8.30 | Outsourced development | Deterministic: SCA on third-party libs; agentic: vendor management policy. |
| A.8.31 | Separation of development, test and production environments | Deterministic: IaC variable files / account separation. |
| A.8.32 | Change management | Deterministic: Git PR approval requirements; CODEOWNERS enforcement. |
| A.8.33 | Test information | Deterministic: test directories scanned for unsanitized production data. |
| A.8.34 | Protection of information systems during audit testing | Deterministic: read-only roles for scanners; no destructive test executions. |

---

## How to use this catalog

1. The SoA tells you which subset applies. Filter this catalog by the SoA before scanning.
2. For each in-scope control, route to the verification mode column.
3. Deterministic controls map to specific Checkov / Trivy / Steampipe checks: see `tool-orchestration.md`.
4. Agentic controls map to LLM prompts: see `agentic-prompts.md`.
5. Out-of-repo controls require evidence pointer verification only.
