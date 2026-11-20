# Outband

**Status: alpha.** The API is a draft (`1.0.0-draft.N`) and may change in
breaking ways until 1.0.0. Do not expose an alpha build to the internet.

Outband is a fork of [MeshCentral](https://github.com/Ylianst/MeshCentral)
that adds a public, versioned HTTP API (`/api/v1`) with API tokens, and a
new web UI built on that API. Under the hood it is MeshCentral: the same
database, agents, permission model, Intel AMT support, power control and
relays. The existing MeshCentral UI stays available alongside it.

MeshCentral is the work of Ylian Saint-Hilaire and the MeshCentral
contributors. Outband would not exist without it. See [NOTICE](NOTICE).

## The API

* Specification: [`api/openapi.yaml`](api/openapi.yaml) (OpenAPI 3.1).
* Browser sessions (`/api/v1/auth/login`, with two-factor login), and API
  tokens for machine clients (`Authorization: Bearer obt_…`), with scopes,
  expiry, group and address restrictions, and a runtime kill switch.
* Server-side session records with an absolute lifetime and a persisted
  revocation list, which apply to the legacy UI as well.
* Strict Host and Origin checks, CSRF protection, no CORS, rate limits, log
  redaction, and an Outband audit log with its own retention.

The implementation lives in [`outband/`](outband/). Resource endpoints are
built on the interface described in
[`outband/CONTRIBUTING-API.md`](outband/CONTRIBUTING-API.md).

## Quick start (Docker)

```sh
docker run -d --name outband \
  -p 443:443 \
  -e DYNAMIC_CONFIG=true \
  -e HOSTNAME=outband.example.com \
  -v outband-data:/opt/meshcentral/meshcentral-data \
  ghcr.io/bare-metal-coder/outband:master
```

Then open `https://outband.example.com/` and create the first account,
which becomes the site administrator. The API needs a real server name:
set `HOSTNAME` (or `cert` / a domain `dns` in `config.json`) to the name
clients use (`DYNAMIC_CONFIG=true` applies the environment to
`config.json` at every start). The image is built from [`docker/Dockerfile`](docker/Dockerfile);
see [`docker/README.md`](docker/README.md) for every option.

API settings go under `settings.outbandApi` in `config.json`:

```json
{
  "settings": {
    "sessionKey": "<long random secret>",
    "outbandApi": {
      "enabled": true,
      "sessionLifetimeHours": 12,
      "auditRetentionDays": 365,
      "bearer": true
    }
  }
}
```

## Deployment notes

* **`sessionKey` (required).** Set `settings.sessionKey` in `config.json`
  to a long random value and keep it secret, like a password. It signs the
  session cookies; without it the server picks a new key at every start and
  every browser session ends on restart. Rotating it logs everyone out.
* **Reverse proxies.** List the proxy's address in `trustedProxy` (or
  `tlsOffload`) as an address or CIDR. Outband uses `X-Forwarded-Host` and
  `X-Forwarded-Proto` only from those addresses, and only their last value,
  so the proxy must overwrite these headers rather than append to what the
  client sent.
* **Single server only.** In this alpha the API answers `503` when
  MeshCentral runs as part of a multi-server (peering) setup.
* **API switch.** `settings.outbandApi.enabled: false` turns `/api/v1` off
  (every endpoint except `/api/v1/health` answers `503`).
* **Credential changes and revocation.** Setting a new password in
  MeshCentral (by any path) or an administrator's "change at next login"
  reset ends the user's earlier `/api/v1` sessions and API tokens. A
  password change made at an external identity provider (LDAP, SSO / OIDC,
  SAML) is not visible to Outband and revokes nothing. When an account may
  be compromised, revoke its tokens with `DELETE /api/v1/admin/tokens/{id}`
  and lock the account in MeshCentral (a locked account's sessions and
  tokens are refused on every request), or turn all bearer tokens off at
  once with the kill switch (`PUT /api/v1/admin/settings` with
  `{"bearer": false}`).
* **Serial-over-LAN consoles.** The server opens Intel AMT redirection
  itself and pins each device's AMT certificate on first use; a changed
  certificate is refused until a full site administrator resets the pin
  (`DELETE /api/v1/admin/devices/{id}/amt-pin`). Configure AMT with TLS
  (port 16995) or use CIRA: without TLS, the redirection port 16994 carries
  the digest exchange and the keystrokes in clear on the local network.
* **Database restores.** Restoring a MeshCentral database backup revokes
  `/api/v1` sessions and tokens once for every user whose `passchange`
  differs from the backup. This is intended: Outband cannot tell a restored
  password from a new one, so it fails closed.

## Development

```sh
npm ci
npm test                    # in-process tests and spec contract checks
OUTBAND_LIVE=1 npm test     # also runs a real server on 127.0.0.1:4431 (throwaway data in .outband-test/)
ln -s ../../scripts/pre-push .git/hooks/pre-push   # gitleaks before every push
```

Node.js 22 or later is required.

## MeshCentral documentation

Everything about running MeshCentral (configuration, databases, TLS
offloading, agents, Intel AMT) applies to Outband:
[MeshCentral documentation](https://ylianst.github.io/MeshCentral/).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
