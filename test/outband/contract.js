/**
 * Contract checks: validate responses against api/openapi.yaml (OpenAPI 3.1, JSON Schema 2020-12).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '../../api/openapi.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addKeyword('x-extensible-enum');
ajv.addVocabulary(['discriminator', 'example', 'x-default-mapping']);
ajv.addSchema({ $id: 'spec', components: spec.components });

function rewriteRefs(s) {
    if (Array.isArray(s)) return s.map(rewriteRefs);
    if ((s == null) || (typeof s != 'object')) return s;
    const o = {};
    for (const k of Object.keys(s)) { o[k] = (k == '$ref') ? ('spec' + s[k]) : rewriteRefs(s[k]); }
    return o;
}

function resolve(obj) {
    while (obj && obj.$ref) { const parts = obj.$ref.replace('#/', '').split('/'); obj = parts.reduce(function (a, p) { return a[p]; }, spec); }
    return obj;
}

/** Find the spec operation for a method and concrete path. */
function findOperation(method, urlPath) {
    const p = urlPath.split('?')[0];
    for (const tpl of Object.keys(spec.paths)) {
        const re = new RegExp('^' + tpl.replace(/\{[^}]+\}/g, '[^/]+') + '$');
        if (re.test(p) && spec.paths[tpl][method.toLowerCase()]) return { tpl: tpl, op: spec.paths[tpl][method.toLowerCase()] };
    }
    return null;
}

const compiled = new Map();

/**
 * Validate a response. Throws with a readable message on mismatch.
 * Checks: the status is documented (or covered by `default`), the JSON body
 * matches the schema, and documented RateLimit headers are present on 2xx.
 */
function check(method, urlPath, res) {
    const found = findOperation(method, urlPath);
    if (found == null) throw new Error('No spec operation for ' + method + ' ' + urlPath);
    const responses = found.op.responses;
    let r = responses[String(res.status)];
    let documented = true;
    if (r == null) { r = responses.default; documented = false; }
    if (r == null) throw new Error(method + ' ' + found.tpl + ': status ' + res.status + ' not documented');
    r = resolve(r);
    if ((!documented) && (res.status < 400)) throw new Error(method + ' ' + found.tpl + ': success status ' + res.status + ' not documented');
    const headers = res.headers || {};
    if (headers['outband-api-version'] !== spec.info.version) throw new Error('Outband-API-Version header ' + headers['outband-api-version'] + ' != ' + spec.info.version);
    if (!headers['outband-request-id']) throw new Error('Missing Outband-Request-Id');
    if (r.headers && (res.status < 300)) {
        for (const h of Object.keys(r.headers)) { if (h.startsWith('RateLimit-') && (headers[h.toLowerCase()] == null)) throw new Error(method + ' ' + found.tpl + ': missing header ' + h); }
    }
    const content = r.content && (r.content['application/json'] || null);
    if (content == null) {
        if ((res.text || '').length > 0 && !(r.content && r.content['text/event-stream'])) throw new Error(method + ' ' + found.tpl + ' ' + res.status + ': unexpected body');
        return;
    }
    const key = found.tpl + ' ' + method + ' ' + res.status + (documented ? '' : ' default');
    let v = compiled.get(key);
    if (v == null) { v = ajv.compile(rewriteRefs(content.schema)); compiled.set(key, v); }
    if (!v(res.body)) throw new Error(method + ' ' + found.tpl + ' ' + res.status + ' body does not match the spec: ' + ajv.errorsText(v.errors) + '\n' + JSON.stringify(res.body));
}

/** Validate a value against a named component schema. */
function checkSchema(name, value) {
    const key = 'schema:' + name;
    let v = compiled.get(key);
    if (v == null) { v = ajv.getSchema('spec#/components/schemas/' + name); compiled.set(key, v); }
    if (!v(value)) throw new Error(name + ' does not match: ' + ajv.errorsText(v.errors) + '\n' + JSON.stringify(value));
}

module.exports = { check, checkSchema, spec };
