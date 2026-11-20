#!/usr/bin/env node
// CLI for the Outband mock (see mock/app.mjs for users and test hooks).
//   node mock/server.mjs [--port 4480] [--static ../public/app] [--quiet]
import { createMock } from './app.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = Number(opt('--port', process.env.MOCK_PORT ?? 4480));
const STATIC = opt('--static', null);
createMock({ static: STATIC, quiet: args.includes('--quiet') }).listen(PORT, '127.0.0.1', () =>
  console.log(`outband mock on http://127.0.0.1:${PORT}${STATIC ? ` serving ${STATIC}` : ''}`),
);
