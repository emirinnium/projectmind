# Privacy / GDPR Notes — Agent Fingerprint (Question 7)

## What AgentFingerprint contains
- `asyncPreference`: numeric preference for async/await patterns
- `typeStrictness`: numeric strictness metric
- `errorHandlingStyle`: string descriptor (e.g., `try-catch`, `result-pattern`)
- `namingConvention`: string descriptor (e.g., `camelCase`, `PascalCase`)
- `testPattern`: string descriptor
- `favoriteAbstractions`: array of abstraction names

## GDPR Article 4(1) assessment
These metrics describe **code patterns**, not natural persons. They do not identify, relate to, or could reasonably be linked to an identified or identifiable natural person on their own. Therefore, `AgentFingerprint` is **NOT personally identifiable information (PII)** under GDPR Article 4(1).

## When it CAN become PII
If `agentName` (stored in `agent_profiles.agent_name`) is linked to a real person's identity (e.g., `alice.smith@company.com` or `Alice Smith`), the profile as a whole may become personal data. In that case:
- **Anonymize**: use pseudonymous agent IDs (`agent-001`, `agent-42`) instead of real names.
- **Consent-based**: if real names are required, obtain explicit consent and document the legal basis (Art. 6(1)(a) or (f)).
- **Retention**: apply data-minimization and retention limits to `agent_profiles` rows.

## Recommendation
Use pseudonymous agent IDs (`agent-001`) for `agentName` in `persistAgentProfile()` and `loadAgentProfile()` to maintain GDPR compliance by design.
