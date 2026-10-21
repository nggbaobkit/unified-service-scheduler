import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createApp } from './app.js';
import { openDatabase } from './persistence/database.js';

const { values } = parseArgs({ options: { database: { type: 'string' }, port: { type: 'string' } } });
const port = z.coerce.number().int().min(1024).max(65535).parse(values.port ?? process.env.PORT ?? 3001);
const path = resolve(values.database ?? process.env.DATABASE_PATH ?? '.data/scheduler.sqlite');
mkdirSync(dirname(path), { recursive: true });
const db = openDatabase(path);
const app = createApp(db, { port, clientDirectory: resolve('dist/client') });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'ready', url: `http://127.0.0.1:${port}`, database: path }));
});
server.on('error', error => {
  console.error(JSON.stringify({ event: 'startup_failed', message: error.message }));
  db.close();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => db.close()));
}
