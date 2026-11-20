/**
 * @description Outband API: /health and /server.
 * @license Apache-2.0
 */

'use strict';

const { API_VERSION, OUTBAND_VERSION } = require('../util');
const twofa = require('../twofa');

module.exports = function (core) {
    const parent = core.parent;

    // GET /api/v1/health (no authentication, shows nothing about the configuration)
    async function health(req, res) {
        if (core.state == 'starting') { res.status(503).json({ status: 'starting' }); return; }
        if (core.state != 'ready') { res.status(503).json({ status: 'starting' }); return; }
        const dbOk = await new Promise(function (resolve) {
            const t = setTimeout(function () { resolve(false); }, 2000);
            try { core.webserver.db.Get('outband-health-probe', function (err) { clearTimeout(t); resolve(err == null); }); } catch (ex) { clearTimeout(t); resolve(false); }
        });
        if (!dbOk) { res.status(503).json({ status: 'starting' }); return; }
        res.status(200).json({ status: core.degraded ? 'degraded' : 'ok' });
    }

    // GET /api/v1/server
    async function server(req, res, ctx) {
        const domain = req.xdomain;
        const amt = (parent.amtManager != null);
        res.json({
            name: (typeof domain.title == 'string' && domain.title.length > 0) ? domain.title : 'Outband',
            version: parent.currentVer || '',
            outband_version: OUTBAND_VERSION,
            api_version: API_VERSION,
            features: {
                amt: amt,
                twofa: { available: twofa.available(core, domain), ip_exemptions: twofa.ipExemptions(domain), methods: twofa.serverMethods(core, domain) },
                api_tokens: core.settings.bearer(),
                console_kinds: amt ? ['sol'] : [],
                legacy_ui: true
            }
        });
    }

    return { health, server };
};
