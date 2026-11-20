/**
 * @description Outband API: the resource interface (groups, devices, events,
 * power, stream, console relay).
 *
 * The router authenticates the request, applies CSRF, rate limits and
 * parameter validation, then calls one method of a `Resources` object with
 * the authenticated context. Every method either resolves to a value the
 * router sends, or throws an `ApiError`. This file defines the interface
 * and a stub implementation that answers `501 not_implemented`. A real
 * implementation is registered with `core.setResources(impl)`.
 * See outband/CONTRIBUTING-API.md.
 * @license Apache-2.0
 */

'use strict';

const { ApiError } = require('./util');

/**
 * @typedef {import('./auth').AuthContext} AuthContext
 * @typedef {{limit: number, cursor: object|null}} PageArgs  cursor is the decoded object you encoded earlier
 * @typedef {{items: object[], next: object|null}} PageResult  `next` is encoded by the router into next_cursor
 */

/**
 * @interface Resources
 *
 * listGroups(ctx: AuthContext, args: PageArgs): Promise<PageResult>                  // items: spec Group
 * getGroup(ctx, groupId: string): Promise<object>                                     // spec Group; 404 when not visible
 * listDevices(ctx, args: PageArgs & {group?: string, status?: 'online'|'offline'|'amt', q?: string}): Promise<PageResult>  // items: spec Device
 * getDevice(ctx, deviceId: string): Promise<object>                                   // spec DeviceDetail
 * powerAction(ctx, deviceId: string, body: {action: string, via?: string}, opts: {idempotencyKey: string|null}): Promise<object>  // spec PowerResult, sent as 202
 * listDeviceEvents(ctx, deviceId: string, args: PageArgs & {since?: Date, until?: Date}): Promise<PageResult>  // items: spec Event
 * listEvents(ctx, args: PageArgs & {device?: string, group?: string, type?: string, audit?: boolean, since?: Date, until?: Date}): Promise<PageResult>
 * consoleTarget(ctx, deviceId: string, kind: 'sol'|'terminal'): Promise<{deviceId: string, groupId: string}>
 *     // visibility (404), scope `console` (403), rights for kind (403), reachability (409); the router issues the ticket
 * openConsole(ws: WebSocket, ctx: AuthContext, binding: {deviceId, kind}): void      // relay after the ticket was consumed
 * stream(ctx, req, res, args: {types: string[]|null, lastEventId: string|null}): Promise<void>  // SSE; owns the response
 */

/**
 * Privacy contract (required). Every Device, DeviceDetail and Event object,
 * in REST responses and in stream messages, MUST be built by the mappers in
 * `outband/mappers.js`:
 *   mapDevice(ctx, node, info), mapDeviceDetail(ctx, node, info), mapEvent(ctx, event)
 * and they MUST decide each private field through the AuthContext helpers:
 *   ctx.seesDeviceAddresses()  for `ips` and `hardware.serial`
 *   ctx.seesIdentities()       for user and token names (else ctx.pseudonymUser / ctx.pseudonymToken)
 *   ctx.seesSourceIp()         for `source_ip` and `ip` / `email` message parameters
 * and build Outband audit messages with `Audit.message(doc)`. No other code
 * path may produce these objects. test/outband/privacy-contract.js checks
 * the mappers and must pass.
 */

function notImplemented() { throw new ApiError(501, 'not_implemented', 'Not implemented yet'); }

/** @returns {Resources} */
function createStubResources() {
    return {
        listGroups: async function () { notImplemented(); },
        getGroup: async function () { notImplemented(); },
        listDevices: async function () { notImplemented(); },
        getDevice: async function () { notImplemented(); },
        powerAction: async function () { notImplemented(); },
        listDeviceEvents: async function () { notImplemented(); },
        listEvents: async function () { notImplemented(); },
        consoleTarget: async function () { notImplemented(); },
        openConsole: function (ws) { try { ws.close(1011); } catch (ex) { } },
        stream: async function () { notImplemented(); }
    };
}

module.exports = { createStubResources };
