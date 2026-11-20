/**
 * @description Outband API: settings from config.json (`settings.outbandApi`).
 * MeshCentral lower-cases config keys, so they are read in lower case here.
 * @license Apache-2.0
 */

'use strict';

function num(v, def, min, max) {
    if ((typeof v != 'number') || !Number.isFinite(v)) return def;
    if ((min != null) && (v < min)) return min;
    if ((max != null) && (v > max)) return max;
    return v;
}

function readConfig(parent) {
    const s = ((parent.config && parent.config.settings && parent.config.settings.outbandapi) || {});
    const rl = (typeof s.ratelimits == 'object' && s.ratelimits) ? s.ratelimits : {};
    return {
        enabled: (s.enabled !== false), // false: every endpoint except /health answers 503
        sessionLifetimeMs: num(s.sessionlifetimehours, 12, 1, 24 * 30) * 3600000,
        auditRetentionDays: num(s.auditretentiondays, 365, 1, 3650),
        bearerDefault: (s.bearer !== false),
        rateLimits: {
            requestsPerMinute: num(rl.requestsperminute, 600, 1),
            powerPerMinute: num(rl.powerperminute, 30, 1),
            streams: num(rl.streams, 5, 1),
            devicePowerPerMinute: num(rl.devicepowerperminute, 6, 1),
            invalidBearer: num(rl.invalidbearer, 30, 1),
            invalidBearerWindowMinutes: num(rl.invalidbearerwindowminutes, 10, 1),
            accountFailures: num(rl.accountfailures, 10, 1),
            accountWindowMinutes: num(rl.accountwindowminutes, 15, 1),
            healthPerMinute: num(rl.healthperminute, 120, 1)
        }
    };
}

module.exports = { readConfig };
