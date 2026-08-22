# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Reporting a Vulnerability

ProjectMind takes security seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

1. **Do NOT** open a public GitHub issue for security vulnerabilities.
2. Email the maintainers directly with:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 7 days
- **Fix Timeline**: Depending on severity, typically within 30 days

## Security Features

ProjectMind includes the following security analysis capabilities:

- **Secret Detection**: Identifies potential API keys, passwords, and tokens in code
- **OWASP Checks**: Scans for common security anti-patterns
- **Taint Analysis**: Tracks data flow from sources to sinks (e.g., file → eval)
- **Weak Crypto Detection**: Identifies outdated or weak cryptographic patterns

## Dependencies

ProjectMind regularly audits its dependencies for known vulnerabilities. Run `npm audit` to check the current status.

## Best Practices

When using ProjectMind:

1. **Never commit real secrets** to your repository
2. Use environment variables for sensitive configuration
3. Enable `projectmind.offline` mode to prevent code from being sent to cloud LLM providers
4. Review all AI-generated suggestions before applying them

## Security Contact

For security concerns, please open a private GitHub security advisory or contact the repository maintainers.
