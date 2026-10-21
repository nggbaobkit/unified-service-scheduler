import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { prepareDemo } from '../persistence/seed.js';

try {
  const { values } = parseArgs({ options: { database: { type: 'string' }, date: { type: 'string' } } });
  const result = prepareDemo(resolve(values.database ?? '.data/demo.sqlite'), values.date);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Demo preparation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
