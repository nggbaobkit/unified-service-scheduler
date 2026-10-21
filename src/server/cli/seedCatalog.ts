import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDatabase } from '../persistence/database.js';
import { seedCatalog } from '../persistence/seed.js';

try {
  const { values } = parseArgs({ options: { database: { type: 'string' } } });
  const path = resolve(values.database ?? process.env.DATABASE_PATH ?? '.data/scheduler.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = openDatabase(path);
  try {
    seedCatalog(db);
    console.log(`Sample catalog ready in ${path}. Existing appointments were preserved.`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error(`Seeding failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
