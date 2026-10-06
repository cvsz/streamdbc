# Security Policy

## Supported versions

Security fixes are applied to the active `main` branch and the current release line derived from it.

| Version / branch | Security support |
|---|---|
| `main` | Supported |
| Active release tag/branch | Supported while maintained |
| Feature branches | Best effort until merged |
| Historical snapshots | Not supported |

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, authentication bypasses, remote-code-execution paths, sensitive stream URLs, private infrastructure details, or exploitable crash conditions.

Use GitHub private vulnerability reporting when available. If private reporting is unavailable, contact the repository owner through the private contact method on the GitHub profile. Include the affected commit/tag, component, reproduction steps, impact, exploitability assumptions, and only the proof-of-concept material required to validate the report. Never include real production credentials, tokens, camera passwords, or customer data.

## Security automation

Release gates include Dependabot, CodeQL, `go mod verify`, module tidiness checks, race tests, `staticcheck`, `gosec`, `go vet`, `govulncheck`, Android TV tests/lint/assembly, desktop dependency/build validation, container vulnerability scanning, and SBOM generation.

A successful scanner run means the analysis completed; it does not prove that no vulnerabilities exist. Valid alerts must be fixed in source or dependencies rather than dismissed merely to make a dashboard green.

## Secrets and credentials

Never commit API keys, JWT signing secrets, passwords, credential-bearing RTSP URLs, Android signing keys, NDI Vendor IDs, licensed SDK credentials, private certificates, SSH keys, or production `.env` files.

The desktop client must store the management API key using Electron `safeStorage` or equivalent OS-backed encryption and must not persist it in plaintext settings. The Android TV client stores RTSP channel configuration using Android Keystore-backed AES-GCM.

## Network security

RTSP is normally plaintext in transit. Do not expose camera RTSP ports directly to the public Internet; use a trusted LAN or authenticated private network.

Public HTTP/WebRTC deployments must use TLS at the service or trusted reverse proxy, explicit CORS origins, bounded request sizes/timeouts, and authenticated management operations. Forwarded client IP headers may only be trusted from explicitly configured trusted proxies.

## NDI / vMix

The official NDI SDK, headers, `libndi.so`, Vendor IDs, and other licensed artifacts are not vendored by default. Obtain them only from the official distribution channel and comply with the applicable license.

Production NDI releases require licensed-SDK compilation, ABI validation, source-loss recovery tests, device-level soak testing, and verification against intended vMix/NDI modes. Stub-only CI is not evidence of real NDI interoperability.

## Alert handling

For each finding: inspect the data flow, fix valid vulnerable code/configuration, add a regression test when practical, rerun the relevant CI/security workflow, and dismiss only documented false positives or non-exploitable test-only conditions.

## Release gates

Do not approve a production release unless all applicable required checks pass, no unresolved critical/high vulnerability blocks release, dependency advisories are reviewed, secrets are runtime-injected, release artifacts are reproducible, rollback/restore procedures are verified, and protocol/device interoperability claims have target-environment evidence.

The repository contains a hardened control plane and bounded protocol components. A green CI pipeline does not imply that every media-protocol path or licensed third-party integration is a complete production media plane.
