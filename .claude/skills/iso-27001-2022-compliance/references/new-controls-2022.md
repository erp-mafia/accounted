# 11 New Controls Introduced in ISO/IEC 27001:2022

The 2022 revision condensed 114 controls (in 14 domains) down to 93 controls (in 4 themes). 57 legacy controls were merged into 24 modern equivalents, 58 were retained with minor updates, and 11 were introduced net-new. The 11 net-new controls are the most likely automation gaps when transitioning from a 2013-era compliance program.

The October 31, 2025 transition deadline has now passed, so any active certification must be against the 2022 standard. Treat absence of these 11 controls in a SoA as a presumptive transition failure.

## The 11 new controls

### A.5.7 Threat Intelligence
**Intent**: Collect and analyze information about threats to inform risk treatment.
**Repository signal**: Active SCA tooling (Trivy, Snyk, Dependabot, Mend) with continuously updated vulnerability databases. Threat-intel feed subscriptions documented.
**Common gap**: Organizations have a vuln scanner but no documented threat-intel ingestion process. The control requires both.

### A.5.23 Information security for use of cloud services
**Intent**: Specify, manage, and review security requirements for acquiring and using cloud services.
**Repository signal**: IaC templates aligned with cloud provider security baselines (CIS AWS Foundations Benchmark, CIS Azure Benchmark, CIS GCP Benchmark). Cloud account governance documented (landing zones, organizational policies).
**Common gap**: Multi-account / multi-cloud deployments without a documented cloud security strategy. SoA inclusion is mandatory for any organization using IaaS/PaaS.

### A.5.30 ICT readiness for business continuity
**Intent**: Plan, implement, maintain, and test ICT readiness based on business continuity objectives.
**Repository signal**: Multi-AZ / multi-region deployment in IaC. Backup automation. Documented RTO/RPO. Disaster recovery runbooks. DR test evidence.
**Common gap**: Backups exist but restore procedures are never tested. The control requires evidence of testing.

### A.7.4 Physical security monitoring
**Intent**: Monitor premises continuously for unauthorized physical access.
**Repository signal**: Out-of-repo. Verify policy + pointer to CCTV / access log system. For fully remote organizations, document the exclusion in the SoA with justification.
**Common gap**: Organization claims "we are remote-first" but employees still have home offices with company equipment. Document the boundary.

### A.8.9 Configuration management
**Intent**: Establish, document, implement, monitor, and review configurations of hardware, software, services, and networks.
**Repository signal**: All infrastructure defined as code in version control. Drift detection in pipelines (terraform plan against deployed state). Configuration baselines for OS images / container base images.
**Common gap**: Production resources created via console clickops alongside Terraform-managed resources. The scanner must detect this divergence.

### A.8.10 Information deletion
**Intent**: Ensure information is deleted when no longer required to prevent unauthorized exposure and to meet legal, regulatory, and contractual requirements.
**Repository signal**: S3 lifecycle rules, database TTLs, log retention policies, GDPR right-to-erasure handlers in application code.
**Common gap**: Test/staging environments with stale production-derived data sitting indefinitely.

### A.8.11 Data masking
**Intent**: Use data masking, pseudonymization, or anonymization to protect sensitive information.
**Repository signal**: PII handlers in application code use hashing, tokenization, or format-preserving encryption. Test fixtures use synthetic data. Logging frameworks redact sensitive fields before output.
**Common gap**: Logs include full payloads of API requests with PII intact.

### A.8.12 Data leakage prevention
**Intent**: Apply DLP measures to systems, networks, and devices that process, store, or transmit sensitive information.
**Repository signal**: Egress filtering in security groups / network policies. Restrictive CORS configurations. No public S3/GCS/Azure Blob buckets. Email DLP integration where applicable.
**Common gap**: Unrestricted egress to the internet from production VPCs.

### A.8.16 Monitoring activities
**Intent**: Monitor networks, systems, and applications for anomalous behavior to detect potential information security incidents.
**Repository signal**: Alerting rules deployed via IaC. SIEM integration. Webhook integrations to incident response tooling (PagerDuty, Opsgenie). Anomaly detection on key metrics.
**Common gap**: Logging exists (A.8.15) but nobody is alerted on anomalies. A.8.15 and A.8.16 are distinct: implement both.

### A.8.23 Web filtering
**Intent**: Manage access to external websites to reduce exposure to malicious content.
**Repository signal**: DNS firewall configuration (Cloudflare Gateway, Cisco Umbrella, AWS Route 53 Resolver DNS Firewall). Proxy allow/deny lists. Outbound HTTP egress restricted.
**Common gap**: Endpoint-level web filtering exists but server-side egress is unrestricted.

### A.8.28 Secure coding
**Intent**: Apply secure coding principles to reduce vulnerabilities introduced during development.
**Repository signal**: SAST tooling (Semgrep, SonarQube, CodeQL) in CI/CD. Linter rules for security patterns. Pre-commit hooks. Documented secure coding standards.
**Common gap**: SAST runs but findings are never blocking. The control requires that findings actually gate merges.

## SoA implications

If transitioning from 2013, every SoA must explicitly address these 11 controls. The reasonable defaults for inclusion / exclusion:

| Control | Default | Notes |
|---|---|---|
| A.5.7 | Include | Almost no organization can credibly exclude threat intelligence. |
| A.5.23 | Include if any cloud usage | Exclude only for strictly on-prem orgs. |
| A.5.30 | Include | Business continuity is universal. |
| A.7.4 | Conditional exclusion if remote-only | Document boundary clearly. |
| A.8.9 | Include | If you have any IT infrastructure, this applies. |
| A.8.10 | Include | Data lifecycle is universal. |
| A.8.11 | Conditional | Exclude only if processing zero PII (rare). |
| A.8.12 | Include | Universal. |
| A.8.16 | Include | Universal. |
| A.8.23 | Conditional | Exclude only if all egress is fundamentally restricted by architecture. |
| A.8.28 | Include | Mandatory for any organization developing software. |

Suspicious patterns the auditor should flag:
- More than 2 of these excluded → likely incomplete transition.
- All included as "Planned" → SoA is aspirational rather than reflective of actual state.
- Any included as "Implemented" without corresponding repository evidence → false claim.
