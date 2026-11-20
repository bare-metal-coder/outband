# Implementing /api/v1 resource endpoints

The security core (`outband/`) authenticates every request, enforces the
Host, Origin, CSRF and rate-limit rules, and validates the standard
parameters. Resource endpoints (groups, devices, events, power, stream,
console relay) are implemented behind one interface, `Resources`, defined in
`outband/resources.js`. Until an implementation is registered, each method
answers `501 not_implemented`.

The contract is `api/openapi.yaml`. Read it first: Authorization, Privacy,
Auditing, Rate limits and Live updates all apply to resource endpoints.

## Registering an implementation

```js
// e.g. outband/devices/index.js
module.exports = function createResources(core) {
    return {
        listGroups: async function (ctx, args) { /* ... */ },
        // ... every method of the interface
    };
};

// wired once, after the core is created (outband/index.js or a startup hook):
core.setResources(require('./devices')(core));
```

`core` gives you `core.webserver` (MeshCentral's webserver: `meshes`,
`users`, `GetMeshRights`, `GetNodeWithRights`, `db`), `core.parent`
(MeshCentral: `DispatchEvent`, `AddEventDispatch`), `core.audit`,
`core.limits`, `core.idempotency`, `core.tickets`, `core.bus` and
`core.pseudonyms`.

## What the router has already done

Before your method runs:

1. Availability (`503`), Host (`421`), credentials in the URL (`400`).
2. Credential resolved into an `AuthContext` (`401` otherwise). The owning
   user was loaded from the database for this request.
3. CSRF for cookie requests that are not `GET`/`HEAD` (`403 csrf_failed`).
4. The per-credential limit (`RateLimit-*` headers set, `429` when over).
5. JSON body parsed (`415`/`400`), path ids checked against `Id`, and
   `limit`, `cursor`, `since`, `until`, `group`, `device`, `status`, `q`,
   `type`, `audit`, `types` and `last_event_id` validated and typed.
6. For `powerAction` and `createConsoleTicket`: the 30-per-minute
   power/console limit. For `powerAction`: `Idempotency-Key` handling: a repeated key returns the stored
   result, and a key reused with another body gets `409`.

Your method resolves to the response body. List methods resolve to
`{items, next}`, and the router encodes `next` (any JSON object, or `null`)
into `next_cursor`. Throw `ApiError(status, code, message, details)` from
`outband/util.js` for every refusal; anything else becomes `500 internal`
with nothing leaked.

## The authenticated principal: `AuthContext` (`outband/auth.js`)

| Member | Meaning |
|---|---|
| `ctx.user` | User record from the database (this request). |
| `ctx.userid` | Full id, `user/<domain>/<name>`. |
| `ctx.domain` | MeshCentral domain object. Use `ctx.domain.id` in every id you build. |
| `ctx.method` / `ctx.isCookie` / `ctx.isToken` | Credential type. |
| `ctx.scopes`, `ctx.hasScope(s)`, `ctx.requireScope(s)` | Scopes; `requireScope` throws `403 insufficient_scope`. |
| `ctx.token` | Token record (bearer), with `groups` and `scopes`. |
| `ctx.groupRestriction` | Short group ids the token is limited to, or `null`. |
| `ctx.groupAllowed(id)` | The group restriction allows this group. |
| `ctx.meshRights(meshOrId)` | Owner's effective MeshCentral rights on a group, `0` outside the token's groups. |
| `AuthContext.hasRight(rights, need, mustNot)` | Right check; full rights ignore `mustNot`. |
| `ctx.domainWideEvents()` | `ALLEVENTS` or full admin, and no group restriction. |
| `ctx.seesIdentities()` | Real user and token names in events (else pseudonyms). |
| `ctx.seesSourceIp()` | `source_ip` may be shown. |
| `ctx.seesDeviceAddresses()` | Device `ips` and `hardware.serial` may be shown (sessions, and tokens with `console`). |
| `ctx.pseudonymUser(userid)`, `ctx.pseudonymToken(tokenId)` | Stable per-credential pseudonyms (`u_…`, `t_…`). |
| `ctx.credentialKey` | Stable credential key, for limits and stream bookkeeping. |
| `ctx.ip` | Client address as MeshCentral resolved it. |
| `ctx.revalidate()` | Re-check the credential; resolves to `null` or a `closed` reason. |

### Order of checks

Every handler applies the spec's fixed order: **visibility** (`404
not_found`, identical for "does not exist" and "not visible") then **scope**
(`ctx.requireScope`) then **MeshCentral rights** (`403 forbidden`) then
**reachability** (`409 not_reachable`). Do the visibility check with
`ctx.meshRights(mesh) != 0` (which already applies the token's `groups`).

### Power

Use `outband/power.js`. Build an `env` per device (`groupKind`,
`reachable`, `allowed(path, action)` from rights via `power.rightsFor`) and
call:

* `power.capabilities(env, (s) => ctx.hasScope(s))` for
  `DeviceCapabilities` (`power`, `power_via`, `power_paths`);
* `power.plan(env, action, via)` after visibility and
  `ctx.requireScope(power.scopeForAction(action))`; it returns the paths to
  dispatch on or throws the spec error (`400`/`403`/`409`).

Also apply `core.limits.device.hit(deviceId)` (6 per minute per device) and
audit every dispatch and every `403` (see Audit).

### Console

`consoleTarget(ctx, deviceId, kind)` runs visibility, `console` scope,
rights for `kind` and reachability, and resolves to `{deviceId, groupId}`.
The router issues the ticket, and at the WebSocket upgrade consumes it
atomically, re-checks the credential and Origin, and calls `consoleTarget`
again before calling your `openConsole(ws, ctx, binding)`. Close with
`4403` when `ctx.revalidate()` reports a reason, `4409` when the device
becomes unreachable or busy.

### Stream

`stream(ctx, req, res, {types, lastEventId})` owns the response. `types` is
already split (unknown names must be ignored; `ready`, `resync` and `closed`
are always sent). The router holds one of the 5 stream slots per credential
and frees it when the response closes. Re-check with `ctx.revalidate()` at
least every 5 seconds and also on these `core.bus` events:
`session-ended {userid, x, reason}`, `token-ended {tokenId, reason}`,
`bearer-disabled`. End with a `closed` message carrying the reason.

## Privacy contract (required)

Every Device, DeviceDetail and Event object, in REST responses **and** in
stream messages, MUST be built by the mappers in `outband/mappers.js`:

```js
module.exports = {
    mapDevice(ctx, node, info),        // -> spec Device
    mapDeviceDetail(ctx, node, info),  // -> spec DeviceDetail
    mapEvent(ctx, event)               // -> spec Event (MeshCentral event or Outband audit record)
};
```

They MUST decide each private field through the context helpers, never by
their own rules:

| Field | Helper |
|---|---|
| `ips`, `hardware.serial` | `ctx.seesDeviceAddresses()` |
| user and token names; otherwise `ctx.pseudonymUser(userid)` / `ctx.pseudonymToken(tokenId)` | `ctx.seesIdentities()` |
| `source_ip`, and `ip` / `email` message parameters | `ctx.seesSourceIp()` |
| Outband audit record messages | `Audit.message(doc)` |

`test/outband/privacy-contract.js` feeds private values to the mappers under
several credentials and fails on any leak or on a helper that was not
consulted; `test/outband/privacy.test.js` runs it against
`outband/mappers.js`. The resources change must pass it.

## Redaction and mapping

* Build every response object field by field from an allowlist. Never
  spread or copy MeshCentral objects.
* Leave out `ips` and `hardware.serial` unless `ctx.seesDeviceAddresses()`.
* Event messages: only templates (`Audit.message(doc)` for Outband audit
  records; your own allowlist for MeshCentral events). Never pass free text
  through. User and token identities follow `ctx.seesIdentities()`;
  `source_ip`, `ip` and `email` parameters follow `ctx.seesSourceIp()`.
* Never log request bodies, tokens or tickets. `parent.debug` is already
  wrapped to redact `Authorization`, `Cookie`, `Set-Cookie`,
  `Sec-WebSocket-Protocol`, and `ticket`/`token`/`access_token` query
  values; helpers are in `outband/redact.js`.

## Audit (`core.audit`)

* `core.audit.write({domain, type, action, outcome, user, userName, tokenId, tokenName, deviceId, groupId, actionId, ip, params})`
  for dispatched power actions, console opens and similar.
* `core.audit.deny(ctx.credentialKey, {...})` for denials; it aggregates
  per credential, reason and minute.
* Add a message template for each new `action` in `TEMPLATES` in
  `outband/audit.js`. Parameters must be short, typed values.
* `core.audit.find(query, limit, cursor)` pages Outband audit records for
  the event endpoints.

## Tests

Use `test/outband/harness.js` (in-process server with a fake MeshCentral)
and `test/outband/contract.js` (`check(method, path, response)` validates
status, headers and body against the spec). Every new endpoint needs
contract tests and tests for its refusals.
