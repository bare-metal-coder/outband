/**
 * @description Outband API: sending power commands through MeshCentral.
 *
 * Each path uses the same mechanism as MeshCentral's own UI:
 *   agent  the agent's `poweraction` command (2 off, 3 reset, 4 sleep)
 *   amt    the `amtpoweraction` event handled by MeshCentral's AMT manager
 *          (2 power up, 5 power cycle, 8 power down, 10 reset)
 *   wol    Wake-on-LAN packets from online agents in the device's group,
 *          and from the server
 *   mqtt   the MQTT `powerAction` message
 *   ipkvm  the IP-KVM / PDU port `turnon` / `turnoff` operation
 *
 * The paths come from power.plan(); nothing here chooses a path. Every path
 * is checked for a live handle first, so either all paths are sent or none.
 * @license Apache-2.0
 */

'use strict';

const { ApiError } = require('./util');

const AGENT_ACTION = { off: 2, reset: 3, sleep: 4 };
const AMT_ACTION = { on: 2, wake: 2, cycle: 5, off: 8, reset: 10 };
const MQTT_ACTION = { wake: 'wake', on: 'wake', off: 'poweroff', reset: 'reset', sleep: 'sleep' };

function dbGet(core, id) {
    return new Promise(function (resolve) {
        try { core.webserver.db.Get(id, function (err, docs) { resolve((err || !Array.isArray(docs) || (docs.length != 1)) ? null : docs[0]); }); }
        catch (ex) { resolve(null); }
    });
}

/** MAC addresses MeshCentral knows for a device (its network interface record). */
async function macsOf(core, nodeid) {
    const rec = await dbGet(core, 'if' + nodeid);
    const macs = [];
    const add = function (m) { if ((typeof m == 'string') && /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(m) && (m != '00:00:00:00:00:00') && (macs.indexOf(m) < 0)) macs.push(m); };
    if (rec && rec.netif) { for (const k of Object.keys(rec.netif)) add(rec.netif[k] && rec.netif[k].mac); }
    else if (rec && rec.netif2) { for (const k of Object.keys(rec.netif2)) { const l = rec.netif2[k]; if (Array.isArray(l)) for (const i of l) add(i && i.mac); } }
    return macs;
}

/** Online agents in this group (excluding the target itself), for Wake-on-LAN. */
function wakePeers(core, node) {
    const out = [], agents = core.webserver.wsagents || {};
    for (const id of Object.keys(agents)) {
        const a = agents[id];
        if (a && (a.authenticated == 2) && (a.dbMeshKey == node.meshid) && (a.dbNodeKey != node._id)) out.push(a);
    }
    return out;
}

/**
 * Send `action` on every path in `paths`. Throws 409 not_reachable (nothing
 * sent) when a path has no live handle any more.
 * @returns {Promise<void>}
 */
async function dispatch(core, ctx, node, action, paths) {
    const ws = core.webserver, parent = core.parent;
    const user = { id: ctx.userid, name: ctx.user.name };
    const unreachable = function (p) { return new ApiError(409, 'not_reachable', 'This path cannot carry the action now', { path: p }); };

    // Prepare every path before sending anything.
    const sends = [];
    for (const p of paths) {
        if (p == 'agent') {
            const agent = ws.wsagents && ws.wsagents[node._id];
            if ((agent == null) || (AGENT_ACTION[action] == null)) throw unreachable(p);
            sends.push(function () { try { agent.send(JSON.stringify({ action: 'poweraction', actiontype: AGENT_ACTION[action], userid: user.id, username: user.name, remoteaddr: ctx.ip })); } catch (ex) { } });
        } else if (p == 'amt') {
            if (AMT_ACTION[action] == null) throw unreachable(p);
            sends.push(function () { parent.DispatchEvent(['*'], ws, { action: 'amtpoweraction', userid: user.id, username: user.name, nodeids: [node._id], domain: ctx.domain.id, nolog: 1, actiontype: AMT_ACTION[action] }); });
        } else if (p == 'mqtt') {
            if ((parent.mqttbroker == null) || (MQTT_ACTION[action] == null)) throw unreachable(p);
            sends.push(function () { parent.mqttbroker.publish(node._id, 'powerAction', MQTT_ACTION[action]); });
        } else if (p == 'ipkvm') {
            if ((action != 'on') && (action != 'wake') && (action != 'off')) throw unreachable(p);
            const on = (action != 'off');
            const targets = (typeof ws.CreateNodeDispatchTargets == 'function') ? ws.CreateNodeDispatchTargets(node.meshid, node._id, ['devport-operation', 'server-users', user.id]) : ['*', node.meshid, node._id, user.id];
            sends.push(function () {
                parent.DispatchEvent(targets, ws, { etype: 'node', userid: user.id, username: user.name, nodeid: node._id, action: on ? 'turnon' : 'turnoff', domain: ctx.domain.id, portid: node.portid, porttype: node.porttype, portnum: node.portnum, meshid: node.meshid, mtype: node.mtype, msgid: on ? 132 : 133, msg: on ? 'Turn on.' : 'Turn off.' });
            });
        } else if (p == 'wol') {
            const macs = await macsOf(core, node._id);
            const peers = wakePeers(core, node);
            if ((macs.length == 0) || (peers.length == 0)) throw unreachable(p);
            sends.push(function () {
                if (parent.meshScanner != null) { try { parent.meshScanner.wakeOnLan(macs, node.host); } catch (ex) { } }
                for (const a of peers) { try { a.send(JSON.stringify({ action: 'wakeonlan', macs: macs })); } catch (ex) { } }
            });
        } else {
            throw unreachable(p);
        }
    }
    for (const s of sends) s();
}

module.exports = { dispatch, AGENT_ACTION, AMT_ACTION, MQTT_ACTION };
