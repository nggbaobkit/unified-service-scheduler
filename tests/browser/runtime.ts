import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { prepareDemo } from '../../src/server/persistence/seed.js';
import { openDatabase, listAppointments } from '../../src/server/persistence/database.js';
import type { Appointment } from '../../src/shared/contracts.js';

async function getAvailablePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

type Runtime = {
  url: string;
  day: string;
  nextDay: string;
  getAllAppointments: () => Appointment[];
  restart: () => Promise<void>;
};
export const test = base.extend<{ runtime: Runtime }>({
  runtime: async ({}, use) => {
    mkdirSync(resolve('.data'), { recursive: true });
    const directory = mkdtempSync(resolve('.data/browser-'));
    const path = join(directory, 'demo.sqlite');
    const dates = prepareDemo(path);
    const port = await getAvailablePort();
    let child: ChildProcess | undefined;
    async function stopServer() {
      if (!child || child.exitCode !== null) return;
      const stopped = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill();
      await stopped;
    }
    async function startServer() {
      child = spawn(process.execPath, ['dist/server/server/index.js', '--database', path, '--port', String(port)],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      const processHandle = child;
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 10000);
        processHandle.once('error', error => { clearTimeout(timeout); reject(error); });
        processHandle.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); });
        processHandle.stderr?.on('data', chunk => { output += String(chunk); });
        processHandle.stdout?.on('data', chunk => {
          output += String(chunk);
          if (output.includes('"event":"ready"')) { clearTimeout(timeout); resolve(); }
        });
      });
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (!health.ok) throw new Error('Test server is not healthy.');
    }
    try {
      await startServer();
      await use({
        url: `http://127.0.0.1:${port}`, day: dates.demoDate, nextDay: dates.nextDemoDate,
        getAllAppointments: () => {
          const db = openDatabase(path);
          try { return listAppointments(db); } finally { db.close(); }
        },
        restart: async () => { await stopServer(); await startServer(); },
      });
    } finally {
      await stopServer();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
});
export { expect };
