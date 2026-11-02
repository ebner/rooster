# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)). Only the maintainers can see the report.

Don't open a public issue, pull request or discussion for a vulnerability.

A useful report says:

- the version (Admin → System, `rooster --version`, or the image tag);
- what an attacker can do, and what they need first (an account, an org membership, a token, network position);
- the steps or a proof of concept against your own instance.

rooster is maintained by a small team in its spare time. We aim to confirm a report within a week and to agree on a disclosure date with you once a fix is ready. We credit reporters in the advisory unless you prefer otherwise.

## Supported versions

Fixes go into the latest release. Upgrade to it: images are published to `ghcr.io/201works/rooster` (`:1` follows the latest 1.x), and CLI binaries are attached to each GitHub release.

## Scope

In scope: the server, the web app, the CLI, the TUI, the MCP server and the Docker image built from this repository.

Out of scope: problems that need a component you control to misbehave first (your identity provider, reverse proxy, S3 storage or SMTP relay), denial of service by sheer request volume, and findings from automated scanners without a demonstrated impact.

The [operator guide](docs/operator.md) describes a secure deployment, and [docs/security/](docs/security/) has the ASVS map and the review record.
