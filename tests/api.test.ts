import { afterEach, beforeEach, expect, it } from 'vitest';
import supertest from 'supertest';
import { z } from 'zod';
import { createApp, type LogEntry } from '../src/server/app.js';
import { listAppointments, openDatabase } from '../src/server/persistence/database.js';
import { day, createTestFixture, createBookingIntent, now, createConfirmationRequest } from './fixtures.js';
import type { BookingIntent, ConfirmationRequest } from '../src/shared/contracts.js';
import { Scheduler } from '../src/server/scheduler.js';

let context: ReturnType<typeof createTestFixture>;
beforeEach(() => { context = createTestFixture(); });
afterEach(() => context.dispose());
function createTestApp(options: Parameters<typeof createApp>[1] = {}) {
  return createApp(context.db, { now: () => now, logger: () => {}, ...options });
}
function buildRequestBody(input: BookingIntent | ConfirmationRequest) {
  const { customerId: _customer, ...body } = input;
  return body;
}
function createProfileClient(server = createTestApp(), customerId = 'alex') {
  return supertest.agent(server).set('X-Demo-Customer', customerId);
}

it('lists demo profiles without credentials or cookies and removes obsolete login endpoints', async () => {
  const http = supertest(createTestApp());
  const response = await http.get('/api/profiles').expect(200);
  expect(response.body).toEqual([
    { id: 'alex', name: 'Alex' }, { id: 'jamie', name: 'Jamie' },
    { id: 'riley', name: 'Riley' }, { id: 'taylor', name: 'Taylor' },
  ]);
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(response.headers['cache-control']).toBe('no-store');
  await http.post('/api/auth/login').send({}).expect(404);
  await http.post('/api/auth/logout').send({}).expect(404);
  await http.get('/api/auth/session').expect(404);
});

it('requires a valid selected profile and scopes catalog and appointments to it', async () => {
  const server = createTestApp();
  await supertest(server).get('/api/catalog').expect(400)
    .expect(response => expect(response.body.error.code).toBe('PROFILE_REQUIRED'));
  await supertest(server).get('/api/appointments').set('X-Demo-Customer', 'missing').expect(400)
    .expect(response => expect(response.body.error.code).toBe('PROFILE_NOT_FOUND'));
  await supertest(server).post('/api/availability').send(buildRequestBody(createBookingIntent())).expect(400);
  await supertest(server).post('/api/appointments').send(buildRequestBody(createConfirmationRequest())).expect(400);
  const http = createProfileClient(server);
  const catalog = await http.get('/api/catalog').expect(200);
  expect(catalog.headers['x-demo-customer']).toBe('alex');
  expect(catalog.body.customer).toEqual({ id: 'alex', name: 'Alex' });
  expect(catalog.body).not.toHaveProperty('customers');
  expect(catalog.body).not.toHaveProperty('openingHours');
  expect(catalog.body).not.toHaveProperty('shifts');
  expect(catalog.body).not.toHaveProperty('offerings');
  expect(catalog.body.vehicles.map((vehicle: { id: string }) => vehicle.id)).toEqual(['A1', 'A2']);
  await http.get('/api/appointments?customerId=jamie').expect(200).expect(response => expect(response.body).toHaveLength(0));
  await http.post('/api/availability').send(buildRequestBody(createBookingIntent())).expect(200).expect(response => expect(response.body.available).toBe(true));
  const input = buildRequestBody(createConfirmationRequest());
  const created = await http.post('/api/appointments').send(input).expect(201);
  expect(created.body.appointment.customerId).toBe('alex');
  const replay = await http.post('/api/appointments').send(input).expect(200);
  expect(replay.body.appointment.id).toBe(created.body.appointment.id);
  expect(replay.body.replayed).toBe(true);
  await http.get('/api/appointments').expect(200).expect(response => expect(response.body).toHaveLength(1));
  await createProfileClient(server, 'taylor').get('/api/appointments').expect(200).expect(response => expect(response.body).toHaveLength(0));
});

it('allows any sample profile to be selected explicitly, without server login state', async () => {
  const http = supertest.agent(createTestApp());
  await http.get('/api/appointments').set('X-Demo-Customer', 'jamie').expect(200)
    .expect(response => {
      expect(response.body).toHaveLength(1);
      expect(response.body[0].customerId).toBe('jamie');
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  await http.get('/api/appointments').set('X-Demo-Customer', 'alex').expect(200)
    .expect(response => expect(response.body).toHaveLength(0));
  await http.get('/api/appointments').expect(400);
});

it('rejects conflicting body identity, another profile vehicle and cross-profile replay', async () => {
  const server = createTestApp();
  const alex = createProfileClient(server);
  await alex.post('/api/appointments').send(createConfirmationRequest({ customerId: 'jamie', vehicleId: 'J1' })).expect(422);
  await alex.post('/api/availability').send(createBookingIntent({ customerId: 'jamie', vehicleId: 'J1' })).expect(422);
  await alex.post('/api/appointments').send(buildRequestBody(createConfirmationRequest({ vehicleId: 'J1' }))).expect(422)
    .expect(response => expect(response.body.error.code).toBe('VEHICLE_OWNERSHIP'));
  const input = buildRequestBody(createConfirmationRequest());
  await alex.post('/api/appointments').send(input).expect(201);
  await createProfileClient(server, 'taylor').post('/api/appointments').send({ ...input, vehicleId: 'T1' }).expect(409)
    .expect(response => expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT'));
  expect(listAppointments(context.db)).toHaveLength(3);
});

it('returns structured validation, JSON, origin, host, content-type and routing errors', async () => {
  const http = createProfileClient();
  await http.post('/api/appointments').send({}).expect(422).expect(response => expect(response.body.error.code).toBe('INVALID_REQUEST'));
  await http.post('/api/appointments').send({ ...buildRequestBody(createConfirmationRequest()), durationMinutes: 1 }).expect(422);
  await http.post('/api/availability').set('Content-Type', 'application/json').send('{').expect(400)
    .expect(response => expect(response.body.error.code).toBe('INVALID_JSON'));
  await http.post('/api/availability').set('Origin', 'https://untrusted.example').send(buildRequestBody(createBookingIntent())).expect(403);
  await http.get('/api/catalog').set('Host', 'untrusted.example').expect(403);
  await http.post('/api/availability').set('Content-Type', 'text/plain').send('body').expect(415);
  await http.post('/api/availability').send({ huge: 'x'.repeat(20000) }).expect(413);
  await http.get('/api/missing').expect(404);
});

it('reports explicit conflict without a partial write', async () => {
  const response = await createProfileClient().post('/api/appointments').send(buildRequestBody(createConfirmationRequest({ localStart: `${day}T09:10` }))).expect(409);
  expect(response.body.error).toMatchObject({ code: 'BAY_BUSY', requestId: expect.any(String) });
  expect(listAppointments(context.db)).toHaveLength(2);
});

it('proves rollback via the structured confirm error AND operation-specific injection marker', async () => {
  const logs: LogEntry[] = [];
  let fail = true;
  const http = createProfileClient(createTestApp({
    logger: entry => logs.push(entry),
    afterInsert: () => { if (fail) throw new Error('TEST_CONFIRM_AFTER_INSERT'); },
  }));
  const input = createConfirmationRequest();
  const failed = await http.post('/api/appointments').send(buildRequestBody(input)).expect(500);
  expect(failed.body.error.code).toBe('INTERNAL_ERROR');
  expect(logs).toContainEqual({
    requestId: failed.body.error.requestId, operation: 'confirm', code: 'INTERNAL_ERROR', detail: 'TEST_CONFIRM_AFTER_INSERT',
  });
  expect(listAppointments(context.db)).toHaveLength(2);
  expect(context.db.prepare('SELECT id FROM appointments WHERE idempotencyKey = ?').get(input.idempotencyKey)).toBeUndefined();
  fail = false;
  await http.post('/api/appointments').send(buildRequestBody(input)).expect(201);
  expect(listAppointments(context.db)).toHaveLength(3);
});

it('bounds database contention and distinguishes it from an availability conflict', async () => {
  const http = createProfileClient();
  const holder = openDatabase(context.path);
  holder.exec('BEGIN IMMEDIATE');
  try {
    const response = await http.post('/api/appointments').send(buildRequestBody(createConfirmationRequest())).expect(503);
    expect(response.body.error.code).toBe('DATABASE_BUSY');
    expect(response.headers['retry-after']).toBe('1');
  } finally { holder.exec('ROLLBACK'); holder.close(); }
  expect(listAppointments(context.db)).toHaveLength(2);
});

it.each([1, 2, 3, 4])('migrates schema %s without losing catalog or appointment data', version => {
  const tables = ['customers', 'vehicles', 'dealerships', 'services', 'bays', 'technicians', 'qualifications', 'appointments', 'metadata'];
  const before = Object.fromEntries(tables.map(table => [table, context.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));
  context.db.exec(`
    CREATE TABLE dealershipServices (
      dealershipId TEXT NOT NULL REFERENCES dealerships(id),
      serviceId TEXT NOT NULL REFERENCES services(id),
      PRIMARY KEY(dealershipId, serviceId)
    );
    INSERT INTO dealershipServices SELECT d.id, s.id FROM dealerships d CROSS JOIN services s;
    CREATE TABLE legacyAppointments (
      id TEXT PRIMARY KEY, customerId TEXT NOT NULL REFERENCES customers(id), vehicleId TEXT NOT NULL,
      dealershipId TEXT NOT NULL, serviceId TEXT NOT NULL, technicianId TEXT NOT NULL, bayId TEXT NOT NULL,
      startMs INTEGER NOT NULL, endMs INTEGER NOT NULL CHECK(endMs > startMs),
      durationMinutes INTEGER NOT NULL CHECK(durationMinutes > 0), createdAt INTEGER NOT NULL,
      idempotencyKey TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      CHECK(endMs - startMs = durationMinutes * 60000),
      FOREIGN KEY(vehicleId, customerId) REFERENCES vehicles(id, customerId),
      FOREIGN KEY(dealershipId, serviceId) REFERENCES dealershipServices(dealershipId, serviceId),
      FOREIGN KEY(technicianId, dealershipId) REFERENCES technicians(id, dealershipId),
      FOREIGN KEY(bayId, dealershipId) REFERENCES bays(id, dealershipId),
      FOREIGN KEY(technicianId, serviceId) REFERENCES qualifications(technicianId, serviceId)
    );
    INSERT INTO legacyAppointments SELECT * FROM appointments;
    DROP TABLE appointments;
    ALTER TABLE legacyAppointments RENAME TO appointments;
  `);
  if (version < 4) {
    context.db.exec(`
      CREATE TABLE openingHours (dealershipId TEXT, weekday INTEGER, startTime TEXT, endTime TEXT);
      CREATE TABLE shifts (technicianId TEXT, weekday INTEGER, startTime TEXT, endTime TEXT);
      INSERT INTO openingHours VALUES ('central',1,'09:00','17:00');
      INSERT INTO shifts VALUES ('c1',1,'09:00','12:00'),('c1',1,'13:00','17:00');
    `);
  }
  if (version === 2) {
    context.db.exec("CREATE TABLE accounts (customerId TEXT, username TEXT, passwordHash TEXT); INSERT INTO accounts VALUES ('alex','alex','obsolete-test-only')");
  }
  context.db.pragma(`user_version=${version}`);
  context.db.close();
  const migrated = openDatabase(context.path);
  try {
    expect(migrated.pragma('user_version', { simple: true })).toBe(5);
    for (const table of tables) {
      expect(migrated.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).toEqual(before[table]);
    }
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('accounts','openingHours','shifts','dealershipServices','appointments_next')").all()).toEqual([]);
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    const foreignKeys = z.array(z.object({ table: z.string() })).parse(migrated.pragma('foreign_key_list(appointments)'));
    expect(foreignKeys.map(key => key.table)).toEqual(expect.arrayContaining(['customers', 'vehicles', 'dealerships', 'services', 'technicians', 'bays', 'qualifications']));
    expect(foreignKeys.some(key => key.table === 'dealershipServices')).toBe(false);
    const indexes = z.array(z.object({ name: z.string() })).parse(migrated.pragma('index_list(appointments)'));
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining(['appointments_technician_time', 'appointments_bay_time', 'appointments_vehicle_time']));
    const replay = new Scheduler(migrated, () => now).confirmAppointment({
      customerId: 'jamie', vehicleId: 'J1', dealershipId: 'central', serviceId: 'oil',
      localStart: `${day}T09:00`, idempotencyKey: '00000000-0000-4000-8000-000000000001',
    });
    expect(replay.replayed).toBe(true);
    expect(() => migrated.prepare('UPDATE appointments SET serviceId=? WHERE id=?').run('missing', replay.appointment.id)).toThrow();
  } finally { migrated.close(); }
});
