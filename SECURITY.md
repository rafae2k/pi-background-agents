# Security

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/rafae2k/pi-background-agents/security/advisories/new) rather than a public issue.

## What to keep in mind

Subagents are full pi sessions with the same permissions as the session that started them, including shell access, and they inherit its project trust decision. Reports saved in the system temp directory contain the brief and the agent's final text, so don't put credentials in a brief.
