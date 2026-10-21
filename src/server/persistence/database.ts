import Database from 'better-sqlite3';
import { z } from 'zod';
import { appointmentSchema, catalogSchema, customerCatalogSchema } from '../../shared/contracts.js';

export type Store = Database.Database;

const appointmentDefinition = `(
  id TEXT PRIMARY KEY,
  customerId TEXT NOT NULL REFERENCES customers(id),
  vehicleId TEXT NOT NULL,
  dealershipId TEXT NOT NULL REFERENCES dealerships(id),
  serviceId TEXT NOT NULL REFERENCES services(id),
  technicianId TEXT NOT NULL,
  bayId TEXT NOT NULL,
  startMs INTEGER NOT NULL,
  endMs INTEGER NOT NULL CHECK(endMs > startMs),
  durationMinutes INTEGER NOT NULL CHECK(durationMinutes > 0),
  createdAt INTEGER NOT NULL,
  idempotencyKey TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  CHECK(endMs - startMs = durationMinutes * 60000),
  FOREIGN KEY(vehicleId, customerId) REFERENCES vehicles(id, customerId),
  FOREIGN KEY(technicianId, dealershipId) REFERENCES technicians(id, dealershipId),
  FOREIGN KEY(bayId, dealershipId) REFERENCES bays(id, dealershipId),
  FOREIGN KEY(technicianId, serviceId) REFERENCES qualifications(technicianId, serviceId)
)`;
const appointmentIndexes = `
  CREATE INDEX appointments_technician_time ON appointments(technicianId, startMs, endMs);
  CREATE INDEX appointments_bay_time ON appointments(bayId, startMs, endMs);
  CREATE INDEX appointments_vehicle_time ON appointments(vehicleId, startMs, endMs);
`;

export function openDatabase(path: string, timeout = 250): Store {
  const db = new Database(path, { timeout });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    const version = z.number().parse(db.pragma('user_version', { simple: true }));
    if (version > 5) throw new Error(`Database schema ${version} is newer than this application.`);
    if (version === 0) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL);
          CREATE TABLE vehicles (
            id TEXT PRIMARY KEY, customerId TEXT NOT NULL REFERENCES customers(id),
            label TEXT NOT NULL, UNIQUE(id, customerId)
          );
          CREATE TABLE dealerships (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL);
          CREATE TABLE services (
            id TEXT PRIMARY KEY, name TEXT NOT NULL,
            durationMinutes INTEGER NOT NULL CHECK(durationMinutes > 0 AND durationMinutes <= 1440)
          );
          CREATE TABLE bays (
            id TEXT PRIMARY KEY, dealershipId TEXT NOT NULL REFERENCES dealerships(id),
            name TEXT NOT NULL, UNIQUE(id, dealershipId)
          );
          CREATE TABLE technicians (
            id TEXT PRIMARY KEY, dealershipId TEXT NOT NULL REFERENCES dealerships(id),
            name TEXT NOT NULL, UNIQUE(id, dealershipId)
          );
          CREATE TABLE qualifications (
            technicianId TEXT NOT NULL REFERENCES technicians(id),
            serviceId TEXT NOT NULL REFERENCES services(id),
            PRIMARY KEY(technicianId, serviceId)
          );
          CREATE TABLE appointments ${appointmentDefinition};
          ${appointmentIndexes}
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          PRAGMA user_version = 5;
        `);
      }).immediate();
      return db;
    }
    if (version < 3) {
      db.transaction(() => {
        db.exec(`
          DROP TABLE IF EXISTS accounts;
          PRAGMA user_version = 3;
        `);
      }).immediate();
    }
    if (version < 4) {
      db.transaction(() => {
        db.exec(`
          DROP TABLE IF EXISTS openingHours;
          DROP TABLE IF EXISTS shifts;
          PRAGMA user_version = 4;
        `);
      }).immediate();
    }
    if (version < 5) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE appointments_next ${appointmentDefinition};
          INSERT INTO appointments_next
            (id, customerId, vehicleId, dealershipId, serviceId, technicianId, bayId,
             startMs, endMs, durationMinutes, createdAt, idempotencyKey, fingerprint)
          SELECT id, customerId, vehicleId, dealershipId, serviceId, technicianId, bayId,
                 startMs, endMs, durationMinutes, createdAt, idempotencyKey, fingerprint
          FROM appointments;
          DROP TABLE appointments;
          ALTER TABLE appointments_next RENAME TO appointments;
          ${appointmentIndexes}
          DROP TABLE IF EXISTS dealershipServices;
          PRAGMA user_version = 5;
        `);
      }).immediate();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function getCatalog(db: Store, customerId?: string) {
  const metadata = z.array(z.object({ key: z.string(), value: z.string() }))
    .parse(db.prepare('SELECT key, value FROM metadata').all());
  return catalogSchema.parse({
    customers: customerId === undefined
      ? db.prepare('SELECT * FROM customers ORDER BY id').all()
      : db.prepare('SELECT * FROM customers WHERE id = ?').all(customerId),
    vehicles: customerId === undefined
      ? db.prepare('SELECT * FROM vehicles ORDER BY id').all()
      : db.prepare('SELECT * FROM vehicles WHERE customerId = ? ORDER BY id').all(customerId),
    dealerships: db.prepare('SELECT * FROM dealerships ORDER BY id').all(),
    services: db.prepare('SELECT * FROM services ORDER BY durationMinutes').all(),
    bays: db.prepare('SELECT * FROM bays ORDER BY id').all(),
    technicians: db.prepare('SELECT * FROM technicians ORDER BY id').all(),
    qualifications: db.prepare('SELECT * FROM qualifications').all(),
    demoDate: metadata.find(row => row.key === 'demoDate')?.value ?? null,
    nextDemoDate: metadata.find(row => row.key === 'nextDemoDate')?.value ?? null,
  });
}

export function getCustomerCatalog(db: Store, customerId: string) {
  const { customers, ...data } = getCatalog(db, customerId);
  return customerCatalogSchema.parse({ ...data, customer: customers[0] });
}

const appointmentSelect = `
  SELECT a.id, a.customerId, c.name AS customerName, a.vehicleId, v.label AS vehicleLabel,
    a.dealershipId, d.name AS dealershipName, d.timezone, a.serviceId, s.name AS serviceName,
    a.durationMinutes, a.technicianId, t.name AS technicianName, a.bayId, b.name AS bayName,
    a.startMs, a.endMs, a.createdAt
  FROM appointments a
  JOIN customers c ON c.id = a.customerId JOIN vehicles v ON v.id = a.vehicleId
  JOIN dealerships d ON d.id = a.dealershipId JOIN services s ON s.id = a.serviceId
  JOIN technicians t ON t.id = a.technicianId JOIN bays b ON b.id = a.bayId
`;

export function listAppointments(db: Store, customerId?: string) {
  const query = `${appointmentSelect}${customerId === undefined ? '' : ' WHERE a.customerId = ?'} ORDER BY a.startMs, a.id`;
  return z.array(appointmentSchema).parse(customerId === undefined ? db.prepare(query).all() : db.prepare(query).all(customerId));
}

export function getAppointmentById(db: Store, id: string) {
  return appointmentSchema.parse(db.prepare(`${appointmentSelect} WHERE a.id = ?`).get(id));
}
