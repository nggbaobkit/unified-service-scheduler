import { Temporal } from '@js-temporal/polyfill';
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCatalog, openDatabase, type Store } from './database.js';
import { DomainError, Scheduler } from '../scheduler.js';
import { SERVICE_SCHEDULE } from '../config/workingHours.js';

export const demoTimezone = 'Asia/Ho_Chi_Minh';

export function getNextWorkingDay(date: Temporal.PlainDate) {
  let next = date.add({ days: 1 });
  while (!SERVICE_SCHEDULE.workingDays.includes(next.dayOfWeek)) next = next.add({ days: 1 });
  return next;
}

export function getDemoDates(date?: string, now = Date.now()) {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(demoTimezone).toPlainDate();
  let day: Temporal.PlainDate;
  try {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid format');
    day = date ? Temporal.PlainDate.from(date, { overflow: 'reject' }) : getNextWorkingDay(today);
  } catch {
    throw new DomainError('INVALID_DEMO_DATE', 'Use a future weekday in YYYY-MM-DD format.', 422);
  }
  if (Temporal.PlainDate.compare(day, today) <= 0 || !SERVICE_SCHEDULE.workingDays.includes(day.dayOfWeek)) {
    throw new DomainError('INVALID_DEMO_DATE', 'The demo date must be a future Monday-Friday date in UTC+07:00.', 422);
  }
  return { demoDate: day.toString(), nextDemoDate: getNextWorkingDay(day).toString() };
}

export function seedCatalog(db: Store) {
  db.transaction(() => {
    const customer = db.prepare('INSERT INTO customers VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
    for (const row of [['alex', 'Alex'], ['jamie', 'Jamie'], ['riley', 'Riley'], ['taylor', 'Taylor']]) customer.run(...row);
    const vehicle = db.prepare('INSERT INTO vehicles VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
    for (const row of [
      ['A1', 'alex', 'Blue hatchback'], ['A2', 'alex', 'Silver SUV'], ['J1', 'jamie', 'Green crossover'],
      ['RY1', 'riley', 'White sedan'], ['T1', 'taylor', 'Red wagon'],
    ]) vehicle.run(...row);
    const dealer = db.prepare('INSERT INTO dealerships VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
    dealer.run('central', 'Central Motors', demoTimezone);
    dealer.run('riverside', 'Riverside Motors', demoTimezone);
    const service = db.prepare('INSERT INTO services VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
    service.run('oil', 'Oil change', 30);
    service.run('inspection', 'Inspection', 60);
    service.run('brakes', 'Brake service', 90);
    const bay = db.prepare('INSERT INTO bays VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
    for (const [id, prefix] of [['central', 'C'], ['riverside', 'R']] as const) {
      for (const number of [1, 2]) bay.run(`${prefix}${number}`, id, `${prefix}${number}`);
    }
    const technician = db.prepare('INSERT INTO technicians VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
    const qualification = db.prepare('INSERT INTO qualifications VALUES (?, ?) ON CONFLICT DO NOTHING');
    for (const [id, dealerId, name, specialty] of [
      ['c1', 'central', 'Maya', 'oil'], ['c2', 'central', 'Leo', 'brakes'],
      ['c3', 'central', 'Quinn', null], ['r1', 'riverside', 'Nora', 'oil'],
      ['r2', 'riverside', 'Ishan', 'brakes'],
    ] as const) {
      technician.run(id, dealerId, name);
      if (specialty !== null) qualification.run(id, specialty);
      qualification.run(id, 'inspection');
    }
  }).immediate();
}

export function seedDemo(db: Store, date?: string, now = Date.now()) {
  const dates = getDemoDates(date, now);
  db.transaction(() => {
    seedCatalog(db);
    const scheduler = new Scheduler(db, () => now);
    scheduler.confirmAppointment({
      customerId: 'jamie', vehicleId: 'J1', dealershipId: 'central', serviceId: 'oil',
      localStart: `${dates.demoDate}T09:00`, idempotencyKey: '00000000-0000-4000-8000-000000000001',
    });
    scheduler.confirmAppointment({
      customerId: 'riley', vehicleId: 'RY1', dealershipId: 'central', serviceId: 'brakes',
      localStart: `${dates.demoDate}T09:00`, idempotencyKey: '00000000-0000-4000-8000-000000000002',
    });
    const metadata = db.prepare('INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    metadata.run('demoDate', dates.demoDate);
    metadata.run('nextDemoDate', dates.nextDemoDate);
  }).immediate();
  return dates;
}

export function prepareDemo(path: string, date?: string, now = Date.now()) {
  getDemoDates(date, now);
  mkdirSync(dirname(path), { recursive: true });
  // Exclusive creation establishes ownership before any database writes.
  closeSync(openSync(path, 'wx'));
  let db: Store | undefined;
  try {
    db = openDatabase(path);
    const dates = seedDemo(db, date, now);
    const data = getCatalog(db);
    return {
      database: path, ...dates, timezone: demoTimezone,
      counts: {
        dealerships: data.dealerships.length, bays: data.bays.length, technicians: data.technicians.length,
        services: data.services.length,
        customers: data.customers.length, vehicles: data.vehicles.length, appointments: 2,
      },
    };
  } catch (error) {
    db?.close();
    db = undefined;
    for (const ownedFile of [path, `${path}-wal`, `${path}-shm`]) rmSync(ownedFile, { force: true });
    throw error;
  } finally {
    db?.close();
  }
}
