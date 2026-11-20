// `npm run dev:mock`: the mock API on 4480 plus Vite proxying /api to it.
import { spawn } from 'node:child_process';
const mock = spawn(process.execPath, ['mock/server.mjs', '--port', '4480'], { stdio: 'inherit' });
const vite = spawn('npx', ['vite'], { stdio: 'inherit', env: { ...process.env, OUTBAND_BACKEND: 'http://127.0.0.1:4480' } });
const stop = () => {
  mock.kill();
  vite.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
vite.on('exit', stop);
