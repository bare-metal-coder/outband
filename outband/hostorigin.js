/**
 * @description Outband API: configured names, Host check and Origin check.
 *
 * Configured names of a domain: its `dns` setting if present, otherwise the
 * server certificate name (the placeholder `un-configured` is never a name),
 * plus the host names of the origins in `allowedOrigin`. Names are never
 * derived from the request's Host header.
 * @license Apache-2.0
 */

'use strict';

const PLACEHOLDER_NAMES = ['un-configured'];

function externalPort(args) {
    const p = (args.aliasport != null) ? args.aliasport : args.port;
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 443;
}

/** The primary name, or null when the domain has none. */
function primaryName(domain, certificates) {
    if ((typeof domain.dns == 'string') && (domain.dns.length > 0)) return domain.dns.toLowerCase();
    const cn = certificates && certificates.CommonName;
    if ((typeof cn != 'string') || (cn.length == 0) || (PLACEHOLDER_NAMES.indexOf(cn.toLowerCase()) >= 0)) return null;
    return cn.toLowerCase();
}

/** Parse `allowedOrigin` entries: full https origins, or bare host names. */
function allowedOriginEntries(domain, args) {
    const out = [];
    if (!Array.isArray(domain.allowedorigin)) return out; // `true` is treated as an empty list
    const port = externalPort(args);
    for (const e of domain.allowedorigin) {
        if (typeof e != 'string' || e.length == 0) continue;
        if (e.indexOf('://') >= 0) {
            let u; try { u = new URL(e); } catch (ex) { continue; }
            if (u.protocol != 'https:') continue;
            out.push({ host: u.hostname.toLowerCase(), origin: u.origin.toLowerCase(), port: (u.port ? parseInt(u.port, 10) : 443) });
        } else {
            const h = e.toLowerCase();
            out.push({ host: h, origin: 'https://' + h + ((port != 443) ? (':' + port) : ''), port: port });
        }
    }
    return out;
}

function hostEntries(domain, certificates, args) {
    const port = externalPort(args);
    const list = [];
    const p = primaryName(domain, certificates);
    if (p != null) list.push({ host: p, port: port, origin: 'https://' + p + ((port != 443) ? (':' + port) : '') });
    for (const e of allowedOriginEntries(domain, args)) list.push(e);
    return list;
}

function hasConfiguredName(domain, certificates) { return primaryName(domain, certificates) != null; }

/** Split a Host header value into name and port. */
function parseHost(value) {
    if (typeof value != 'string' || value.length == 0 || value.length > 300) return null;
    let host = value.trim().toLowerCase(), port = null;
    if (host.startsWith('[')) {
        const i = host.indexOf(']'); if (i < 0) return null;
        const rest = host.substring(i + 1); host = host.substring(1, i);
        if (rest.startsWith(':')) port = parseInt(rest.substring(1), 10); else if (rest.length > 0) return null;
    } else {
        const i = host.lastIndexOf(':');
        if (i >= 0) { if (!/^\d{1,5}$/.test(host.substring(i + 1))) return null; port = parseInt(host.substring(i + 1), 10); host = host.substring(0, i); }
    }
    return { host: host, port: port };
}

/** The Host header (or X-Forwarded-Host from a trusted proxy) must be a configured name with the expected port. */
function checkHost(req, domain, certificates, args, trusted) {
    let value = req.headers.host;
    if (trusted && (typeof req.headers['x-forwarded-host'] == 'string')) { value = req.headers['x-forwarded-host'].split(',')[0].trim(); }
    const h = parseHost(value);
    if (h == null) return false;
    for (const e of hostEntries(domain, certificates, args)) {
        if (e.host != h.host) continue;
        const port = (h.port == null) ? 443 : h.port;
        if (port == e.port) return true;
    }
    return false;
}

/** The Origin header must be present and match an expected origin exactly. */
function checkOrigin(req, domain, certificates, args) {
    const o = req.headers.origin;
    if ((typeof o != 'string') || (o.length == 0) || (o == 'null')) return false;
    let u; try { u = new URL(o); } catch (ex) { return false; }
    if (u.protocol != 'https:') return false;
    const origin = u.origin.toLowerCase();
    if (o.replace(/\/$/, '').toLowerCase() != origin) return false; // no path, query or credentials
    for (const e of hostEntries(domain, certificates, args)) { if (e.origin == origin) return true; }
    return false;
}

module.exports = { primaryName, hasConfiguredName, checkHost, checkOrigin, hostEntries, externalPort, parseHost };
