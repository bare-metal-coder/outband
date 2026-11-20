/**
 * @description Outband API: which second factors the server and a user offer through the API.
 * WebAuthn/FIDO keys, push and Duo are not available through v1.
 * @license Apache-2.0
 */

'use strict';

/** Two-factor login is offered by this server's configuration. */
function available(core, domain) {
    const parent = core.parent, args = core.webserver.args;
    const cn = (core.webserver.certificates && core.webserver.certificates.CommonName) || '';
    return (domain.auth != 'sspi') && (cn.indexOf('.') != -1) && (args.nousers !== true) && (parent.config.settings.no2factorauth !== true);
}

function pr(domain) { return (typeof domain.passwordrequirements == 'object' && domain.passwordrequirements) ? domain.passwordrequirements : {}; }

/** The domain exempts some client addresses from the second factor. */
function ipExemptions(domain) {
    const s = pr(domain).skip2factor;
    return (s != null) && ((typeof s == 'string') ? (s.length > 0) : (Object.keys(s).length > 0));
}

function emailOk(core, domain) { return (domain.mailserver != null) && (pr(domain).email2factor !== false); }
function smsOk(core, domain) { return (core.parent.smsserver != null) && (pr(domain).sms2factor !== false); }
function msgOk(core, domain) { return (core.parent.msgserver != null) && (core.parent.msgserver.providers != 0) && (pr(domain).msg2factor !== false); }
function yubiOk(domain) { return (domain.yubikey != null) && (domain.yubikey.id != null) && (domain.yubikey.secret != null); }

/** Methods the server offers through the API. */
function serverMethods(core, domain) {
    if (!available(core, domain)) return [];
    const m = ['otp'];
    if (pr(domain).backupcode2factor !== false) m.push('backup');
    if (emailOk(core, domain)) m.push('email');
    if (smsOk(core, domain)) m.push('sms');
    if (msgOk(core, domain)) m.push('messaging');
    if (yubiOk(domain)) m.push('yubikey');
    return m;
}

/** Methods this user can complete through the API. */
function userMethods(core, domain, user) {
    const m = [];
    if (user.otpsecret) m.push('otp');
    if (user.otpkeys && Array.isArray(user.otpkeys.keys) && user.otpkeys.keys.some(function (k) { return k.u === true; })) m.push('backup');
    if (emailOk(core, domain) && (user.email != null) && (user.emailVerified == true) && (user.otpekey != null)) m.push('email');
    if (smsOk(core, domain) && (user.phone != null)) m.push('sms');
    if (msgOk(core, domain) && (user.msghandle != null)) m.push('messaging');
    if (yubiOk(domain) && Array.isArray(user.otphkeys) && user.otphkeys.some(function (k) { return k.type === 2; })) m.push('yubikey');
    return m;
}

const CODE_FORMATS = {
    otp: /^\d{6}$/, backup: /^\d{8}$/, email: /^\d{8}$/, sms: /^\d{6}$/, messaging: /^\d{6}$/, yubikey: /^[cbdefghijklnrtuv]{44}$/
};

/** A code is acceptable for `method` (or any of `methods` when no method is given). */
function codeFormatOk(code, method, methods) {
    if (typeof code != 'string') return false;
    const list = (method != null) ? [method] : methods;
    return list.some(function (m) { return CODE_FORMATS[m] && CODE_FORMATS[m].test(code); });
}

module.exports = { available, ipExemptions, serverMethods, userMethods, codeFormatOk };
