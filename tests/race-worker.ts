import { openDatabase } from '../src/server/persistence/database.js';
import { DomainError, Scheduler } from '../src/server/scheduler.js';

const [path, serialized] = process.argv.slice(2);
if (!path || !serialized) throw new Error('Worker requires a database path and request.');
const db = openDatabase(path, 3000);
const scheduler = new Scheduler(db, () => Date.parse('2030-01-06T00:00:00Z'));
process.once('message', () => {
  try {
    const result = scheduler.confirmAppointment(JSON.parse(serialized));
    process.send?.({ code: 'CONFIRMED', id: result.appointment.id, replayed: result.replayed });
  } catch (error) {
    process.send?.({ code: error instanceof DomainError ? error.code : 'UNEXPECTED', detail: error instanceof Error ? error.message : String(error) });
  } finally {
    db.close();
    process.disconnect();
  }
});
process.send?.({ ready: true });
