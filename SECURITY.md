# Security Policy

## Supported versions

Security fixes are applied to the active `main` branch and to the current
release line derived from it. Older snapshots, forks, archived artifacts, and
unmaintained branches are not guaranteed to receive security updates.

| Version / branch | Security support |
|---|---|
| `main` | Supported |
| Active release branch/tag | Supported while maintained |
| Feature branches | Best effort until merged |
| Historical snapshots | Not supported |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability that could expose
credentials, authentication bypasses, remote-code-execution paths, sensitive
stream URLs, private infrastructure details, or exploitable crash conditions.

Preferred reporting path:

1. Use GitHub private vulnerability reporting when it is enabled for this
   repository.
2. If private reporting is unavailable, contact the repository owner through
   the private contact method listed on the GitHub profile.
3. Include the affected commit/tag, component, reproduction steps, impact,
   exploitability assumptions, and any proof-of-concept material needed to
   validate the report.
4. Do not include real production credentials, tokens, camera passwords, or
   customer data in the report.

We will triage reports based on exploitability, affected surface, and impact.
Validated findings are fixed in source before public disclosure whenever
possible.

## Security automation

This repository uses multiple automated security gates:

- GitHub Dependabot for dependency vulnerability and update tracking.
- GitHub CodeQL for static analysis of supported languages.
- `gosec`, `go vet`, `staticcheck`, unit tests, and race tests in Go CI.
- Android lint and JVM tests for the Android TV client.
- Container build validation for the server image.

Security automation is treated as a release gate, not as proof that a release
is vulnerability-free. Alerts are remediated in source or dependencies when
the finding is valid; alerts are not dismissed merely to make the dashboard
green.

## Dependency policy

Production dependencies must be pinned or constrained to maintained releases
and updated when security advisories affect the resolved dependency graph.

Current dependency policy includes:

- Go modules are verified with `go mod verify` and checked for tidiness in CI.
- Desktop client dependencies are managed through npm and Dependabot.
- Android dependencies are resolved through Gradle repositories configured in
  the project.
- Licensed or proprietary SDK binaries are not committed unless redistribution
  is explicitly permitted.

When Dependabot proposes an update that materially changes runtime behavior
(for example, a major Electron upgrade), the update must pass the relevant
build and runtime tests before release.

## Secrets and credentials

Never commit:

- API keys
- JWT signing secrets
- passwords
- RTSP URLs containing production credentials
- Android signing keys
- NDI Vendor IDs or licensed SDK credentials
- private certificates or SSH keys
- production `.env` files

The server must receive secrets through runtime configuration or an approved
secret-management mechanism.

The Android TV client stores saved RTSP channel configuration encrypted at rest
using Android Keystore-backed AES-GCM. Complete RTSP URLs containing
credentials must not be written to application logs.

## Android TV / RTSP security

The Android TV client supports operator-supplied RTSP endpoints.

Important security properties:

- Saved channel configuration is encrypted at rest.
- Android backup and device-transfer rules explicitly exclude application data.
- RTSP URLs are validated before use.
- Credential-bearing URLs are redacted before display or diagnostic output.
- No signing key is stored in the repository.

RTSP itself is normally unencrypted in transit. Do not expose camera RTSP ports
directly to the public Internet. Use a trusted private LAN or an authenticated
private network such as WireGuard or Tailscale for remote deployments.

## NDI / vMix integration

The Android TV client includes NDI source discovery and an optional native NDI
receiver integration path for sources such as vMix.

The official NDI SDK, `libndi.so`, headers, Vendor IDs, and related licensed
artifacts are not vendored in this repository by default.

Security and release requirements for NDI include:

- obtain the SDK from the official NDI distribution channel;
- comply with the applicable NDI/Vizrt license;
- do not commit restricted SDK binaries or credentials;
- stage SDK artifacts only in the documented local vendor path;
- verify every supported ABI before release;
- validate source-loss recovery and reconnect behavior;
- test malformed/hostile network conditions on the NDI discovery and receive
  path;
- perform device-level soak testing before claiming production readiness.

The build fails closed to the non-NDI path when the licensed native SDK is not
present.

## Network exposure

Default and sample configurations should bind management services to loopback
or private interfaces unless an operator intentionally changes the exposure
policy.

Before exposing any service publicly:

- enable authentication;
- use TLS termination where applicable;
- restrict inbound ports;
- rotate default or legacy credentials;
- validate reverse-proxy and Cloudflare configuration;
- confirm rate limits and request-size limits;
- verify logs do not contain secrets or sensitive stream URLs.

## Authentication and authorization

Security-sensitive management operations must remain fail-closed.

Expected controls include:

- API-key validation for privileged management operations where configured;
- JWT algorithm, issuer, expiry, stream, and action validation;
- constant-time comparison for configured secrets where applicable;
- explicit rejection of unsupported or unauthenticated publish paths;
- least-privilege access for runtime services and containers.

Do not weaken authentication checks to work around deployment or integration
problems.

## Code scanning and alert handling

For every CodeQL or static-analysis finding:

1. Reproduce or inspect the data flow.
2. Determine whether the finding is valid, configuration-dependent, or a false
   positive.
3. Fix the vulnerable code or configuration when valid.
4. Add or update a regression test when practical.
5. Re-run the relevant CI and CodeQL workflow.
6. Dismiss an alert only when there is documented evidence that it is a false
   positive, test-only condition, or otherwise not exploitable.

A passing CodeQL workflow means the analysis completed successfully; it does
not by itself prove that there are zero open alerts on the repository security
dashboard.

## Release security gates

A production release should not be approved unless all applicable gates pass:

- required GitHub Actions checks are green;
- no known unresolved critical/high vulnerability blocks the release;
- dependency updates required by active advisories are applied;
- CodeQL/static-analysis findings are reviewed;
- container and application builds are reproducible;
- secrets are injected at runtime and are not present in artifacts;
- Android signing material is stored outside the repository;
- RTSP/NDI device interoperability is tested on intended hardware;
- rollback and restore procedures are verified for server deployments.

## Scope and limitations

The repository contains management/control-plane code, streaming protocol
adapters, desktop client code, and Android TV client code. A green CI pipeline
does not automatically mean that every media protocol path has completed
production interoperability, performance, or soak testing.

Security claims in documentation must remain evidence-based and must not imply
that untested media paths or licensed third-party SDK integrations have been
fully validated.
