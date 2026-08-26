# Security Policy

## Reporting a Vulnerability

Do not disclose credentials, private server addresses, player data, or exploit details in a public issue. Use GitHub's private security advisory flow when it is enabled for this repository, or contact the maintainers through an existing private channel.

Include a minimal reproduction, affected version or commit, impact, and any safe mitigation. Redact all secrets before sharing logs or configuration.

## Repository Rules

- API keys and server credentials belong only in untracked local environment files.
- Internal task vaults and requirement/design documents are not part of this repository.
- Minecraft worlds, player profiles, runtime databases, and operational logs are not accepted in pull requests.
- Security-sensitive dependency or configuration changes require a maintainer review.
