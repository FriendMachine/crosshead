# Security policy

Report vulnerabilities privately to **support@crosshead.sh** with "security" in
the subject. Include the version (`crosshead status`), steps to reproduce and
the impact you observed. Please do not open public issues for security reports.

Supported versions: the latest release. Installed runtimes check for updates
unless pinned, but do not install remote code unattended. Verify the published
digest through an independent channel and run
`crosshead update --sha256 <digest>`.

Scope includes the CLI, daemon, host adapters and hooks, local secret handling,
release integrity (installer checksums and the release manifest) and the local
HTTP control surface. Hosted-service issues are also welcome at the same
address.
