import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { listAppointments, getCatalog, openDatabase } from '../src/server/persistence/database.js';
import { DomainError, resolveLocalTime, Scheduler } from '../src/server/scheduler.js';
import { SERVICE_SCHEDULE } from '../src/server/config/workingHours.js';
import { getDemoDates, prepareDemo, seedCatalog } from '../src/server/persistence/seed.js';
import { day, createTestFixture, createBookingIntent, now, createConfirmationRequest } from './fixtures.js';

let context: ReturnType<typeof createTestFixture>;
let scheduler: Scheduler;
beforeEach(() => { context = createTestFixture(); scheduler = new Scheduler(context.db, () => now); });
afterEach(() => context.dispose());

function expectCode(action: () => unknown, code: string) {
  try { action(); expect.fail(`Expected ${code}`); }
  catch (error) { expect(error).toBeInstanceOf(DomainError); expect(error).toHaveProperty('code', code); }
}

describe('booking invariants', () => {
  it('seeds the complete catalog and performs the exact demo with persistent assignments', () => {
    const data = getCatalog(context.db);
    expect([data.dealerships.length, data.bays.length, data.technicians.length, data.services.length,
      data.customers.length, data.vehicles.length]).toEqual([2, 4, 5, 3, 4, 5]);
    expect(listAppointments(context.db)).toHaveLength(2);
    const oil = scheduler.confirmAppointment(createConfirmationRequest()).appointment;
    expect(oil).toMatchObject({ customerId: 'alex', vehicleId: 'A1', technicianName: 'Maya', bayId: 'C1', durationMinutes: 30 });
    expect(listAppointments(context.db)).toHaveLength(3);
    expect(scheduler.previewAvailability(createBookingIntent({ vehicleId: 'A2', serviceId: 'brakes', localStart: `${day}T09:45` })))
      .toMatchObject({ available: false, code: 'TECHNICIAN_BUSY' });
    const brakes = scheduler.confirmAppointment(createConfirmationRequest({ vehicleId: 'A2', serviceId: 'brakes', localStart: `${day}T10:30` })).appointment;
    expect(brakes).toMatchObject({ technicianName: 'Leo', bayId: 'C1', durationMinutes: 90 });
    expect(brakes.startMs).toBe(oil.endMs);
    expect(listAppointments(context.db)).toHaveLength(4);
    const a = createConfirmationRequest({ customerId: 'jamie', vehicleId: 'J1', serviceId: 'brakes', localStart: `${day}T13:00` });
    const b = createConfirmationRequest({ customerId: 'taylor', vehicleId: 'T1', serviceId: 'brakes', localStart: `${day}T13:00` });
    const { idempotencyKey: _aKey, ...aIntent } = a;
    const { idempotencyKey: _bKey, ...bIntent } = b;
    expect(scheduler.previewAvailability(aIntent).available).toBe(true);
    expect(scheduler.previewAvailability(bIntent).available).toBe(true);
    scheduler.confirmAppointment(a);
    expectCode(() => scheduler.confirmAppointment(b), 'TECHNICIAN_BUSY');
    const before = listAppointments(context.db);
    expect(before).toHaveLength(5);
    context.db.close();
    const reopened = openDatabase(context.path);
    try { expect(listAppointments(reopened)).toEqual(before); } finally { reopened.close(); }
  });

  it.each([
    ['BAY_BUSY', { localStart: `${day}T09:10` }],
    ['TECHNICIAN_BUSY', { serviceId: 'brakes', localStart: `${day}T09:45` }],
    ['OUTSIDE_TECHNICIAN_SHIFT', { serviceId: 'brakes', localStart: '2030-01-08T11:00' }],
    ['OUTSIDE_OPENING_HOURS', { serviceId: 'inspection', localStart: '2030-01-08T16:30' }],
    ['OUTSIDE_OPENING_HOURS', { localStart: '2030-01-12T10:00' }],
    ['OUTSIDE_OPENING_HOURS', { localStart: '2030-01-08T08:59' }],
  ])('rejects the complete interval with %s', (code, overrides) => {
    expect(scheduler.previewAvailability(createBookingIntent(overrides))).toMatchObject({ available: false, code });
    expectCode(() => scheduler.confirmAppointment(createConfirmationRequest(overrides)), code);
    expect(listAppointments(context.db)).toHaveLength(2);
  });

  it('allows finishing exactly at a shift or closing boundary', () => {
    expect(scheduler.previewAvailability(createBookingIntent({ serviceId: 'brakes', localStart: `${day}T10:30` })).available).toBe(true);
    expect(scheduler.previewAvailability(createBookingIntent({ localStart: `${day}T16:30` })).available).toBe(true);
  });

  it('protects a vehicle across dealerships, including containment and partial overlap', () => {
    scheduler.confirmAppointment(createConfirmationRequest());
    for (const localStart of [`${day}T09:45`, `${day}T10:00`, `${day}T10:15`]) {
      expectCode(() => scheduler.confirmAppointment(createConfirmationRequest({ dealershipId: 'riverside', serviceId: 'inspection', localStart })), 'VEHICLE_BUSY');
    }
    expect(scheduler.previewAvailability(createBookingIntent({ dealershipId: 'riverside', localStart: `${day}T10:30` })).available).toBe(true);
  });

  it('validates ownership, catalog references, qualification and complete working periods', () => {
    expectCode(() => scheduler.confirmAppointment(createConfirmationRequest({ vehicleId: 'J1' })), 'VEHICLE_OWNERSHIP');
    expectCode(() => scheduler.confirmAppointment(createConfirmationRequest({ serviceId: 'unknown' })), 'SERVICE_NOT_FOUND');
    expectCode(() => scheduler.confirmAppointment(createConfirmationRequest({ dealershipId: 'unknown' })), 'DEALERSHIP_NOT_FOUND');
    expect(scheduler.previewAvailability(createBookingIntent({ dealershipId: 'riverside' })).available).toBe(true);
    context.db.prepare("DELETE FROM qualifications WHERE technicianId='r1' AND serviceId='inspection'").run();
    context.db.prepare("DELETE FROM qualifications WHERE technicianId='r2' AND serviceId='inspection'").run();
    expectCode(() => scheduler.confirmAppointment(createConfirmationRequest({ dealershipId: 'riverside', serviceId: 'inspection' })), 'NO_QUALIFIED_TECHNICIAN');
  });

  it('uses the global service catalog at both dealerships but still requires a qualified technician', () => {
    context.db.prepare('INSERT INTO services VALUES (?, ?, ?)').run('alignment', 'Wheel alignment', 45);
    for (const dealershipId of ['central', 'riverside']) {
      expectCode(() => scheduler.confirmAppointment(createConfirmationRequest({ dealershipId, serviceId: 'alignment' })), 'NO_QUALIFIED_TECHNICIAN');
    }
    context.db.exec("INSERT INTO qualifications VALUES ('c1','alignment'), ('r1','alignment')");
    const central = scheduler.confirmAppointment(createConfirmationRequest({ serviceId: 'alignment' })).appointment;
    const riverside = scheduler.confirmAppointment(createConfirmationRequest({ vehicleId: 'A2', dealershipId: 'riverside', serviceId: 'alignment' })).appointment;
    expect(central).toMatchObject({ serviceId: 'alignment', technicianId: 'c1', dealershipId: 'central' });
    expect(riverside).toMatchObject({ serviceId: 'alignment', technicianId: 'r1', dealershipId: 'riverside' });
  });

  it('rejects past starts, nonexistent dates and daylight-saving ambiguity', () => {
    expectCode(() => scheduler.confirmAppointment(createConfirmationRequest({ localStart: '2030-01-05T10:00' })), 'PAST_START');
    expectCode(() => scheduler.confirmAppointment(createConfirmationRequest({ localStart: '2030-02-30T10:00' })), 'INVALID_LOCAL_TIME');
    expectCode(() => resolveLocalTime('2030-03-10T02:30', 'America/New_York'), 'INVALID_LOCAL_TIME');
    expectCode(() => resolveLocalTime('2030-11-03T01:30', 'America/New_York'), 'INVALID_LOCAL_TIME');
    expect(resolveLocalTime('2030-03-10T03:30', 'America/New_York')).toBe(Date.parse('2030-03-10T07:30:00Z'));
  });

  it('reports ambiguous schedule boundaries rather than silently choosing an offset', () => {
    context.db.prepare("UPDATE dealerships SET timezone='America/New_York' WHERE id='central'").run();
    const ambiguous = new Scheduler(context.db, () => now, undefined, {
      ...SERVICE_SCHEDULE, workingDays: [7], openingHours: [{ startTime: '01:30', endTime: '17:00' }],
    });
    expectCode(() => ambiguous.previewAvailability(createBookingIntent({ localStart: '2030-11-03T10:00' })), 'INVALID_SCHEDULE');
  });

  it('replays success before time checks, and rejects changed intent with the same key', () => {
    const input = createConfirmationRequest();
    const first = scheduler.confirmAppointment(input);
    expect(scheduler.confirmAppointment(input)).toEqual({ ...first, replayed: true });
    const future = new Scheduler(context.db, () => Date.parse('2031-01-01T00:00:00Z'));
    expect(future.confirmAppointment(input).appointment.id).toBe(first.appointment.id);
    expectCode(() => scheduler.confirmAppointment({ ...input, vehicleId: 'A2' }), 'IDEMPOTENCY_CONFLICT');
    expect(listAppointments(context.db)).toHaveLength(3);
  });

  it('enforces foreign-key relationships and duration integrity in storage', () => {
    const booked = scheduler.confirmAppointment(createConfirmationRequest()).appointment;
    expect(() => context.db.prepare("UPDATE appointments SET technicianId='r1' WHERE id=?").run(booked.id)).toThrow();
    expect(() => context.db.prepare("UPDATE appointments SET vehicleId='J1' WHERE id=?").run(booked.id)).toThrow();
    expect(() => context.db.prepare('UPDATE appointments SET endMs=startMs WHERE id=?').run(booked.id)).toThrow();
  });

  it('normal seeding never removes appointments or changes catalog values', () => {
    scheduler.confirmAppointment(createConfirmationRequest());
    context.db.prepare("UPDATE customers SET name='Edited sample' WHERE id='alex'").run();
    const before = listAppointments(context.db);
    seedCatalog(context.db);
    expect(listAppointments(context.db)).toEqual(before);
    expect(getCatalog(context.db).customers.find(row => row.id === 'alex')?.name).toBe('Edited sample');
  });

  it('refuses existing demo files without changing their data', () => {
    const before = listAppointments(context.db);
    expect(() => prepareDemo(context.path, day, now)).toThrow(/EEXIST/);
    expect(listAppointments(context.db)).toEqual(before);
  });

  it('resolves future weekdays in the dealership timezone and rejects bad overrides', () => {
    expect(getDemoDates(undefined, Date.parse('2030-01-04T18:00:00Z'))).toEqual({ demoDate: '2030-01-07', nextDemoDate: '2030-01-08' });
    expect(getDemoDates(undefined, Date.parse('2030-01-03T18:00:00Z'))).toEqual({ demoDate: '2030-01-07', nextDemoDate: '2030-01-08' });
    for (const date of ['2030-01-06', '2030-01-05', '2030-02-30', 'bad', '2029-12-31']) {
      expectCode(() => getDemoDates(date, now), 'INVALID_DEMO_DATE');
    }
  });
});

async function runBookingRace(path: string, inputs: unknown[]) {
  const children = inputs.map(input => fork(fileURLToPath(new URL('./race-worker.ts', import.meta.url)), [path, JSON.stringify(input)], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  }));
  try {
    await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => { if (code) reject(new Error(`Worker exited ${code}`)); });
      child.once('message', value => {
        if (z.object({ ready: z.literal(true) }).safeParse(value).success) resolve();
        else reject(new Error('Unexpected readiness response'));
      });
    })));
    const outcomes = children.map(child => new Promise<{ code: string; id?: string; replayed?: boolean }>((resolve, reject) => {
      child.once('error', reject);
      child.once('message', value => {
        const parsed = z.object({ code: z.string(), id: z.string().optional(), replayed: z.boolean().optional() }).safeParse(value);
        if (parsed.success) resolve(parsed.data); else reject(new Error('Malformed worker result'));
      });
    }));
    for (const child of children) child.send('go');
    const results = await Promise.all(outcomes);
    await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()))));
    return results;
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
}

describe('independent-process concurrency', () => {
  it('commits one winner for the only available technician/bay pair', async () => {
    scheduler.confirmAppointment(createConfirmationRequest({ serviceId: 'inspection', localStart: `${day}T13:00` }));
    const results = await runBookingRace(context.path, [
      createConfirmationRequest({ customerId: 'jamie', vehicleId: 'J1', serviceId: 'brakes', localStart: `${day}T13:00` }),
      createConfirmationRequest({ customerId: 'taylor', vehicleId: 'T1', serviceId: 'brakes', localStart: `${day}T13:00` }),
    ]);
    expect(results.map(result => result.code).sort()).toEqual(['CONFIRMED', 'TECHNICIAN_BUSY']);
    const rows = listAppointments(context.db);
    expect(rows).toHaveLength(4);
    expect(rows.find(row => row.id === results.find(result => result.code === 'CONFIRMED')?.id))
      .toMatchObject({ technicianName: 'Leo', bayId: 'C2' });
  });
  it('protects the same vehicle across independent dealership resources', async () => {
    const results = await runBookingRace(context.path, [createConfirmationRequest(), createConfirmationRequest({ dealershipId: 'riverside' })]);
    expect(results.map(result => result.code).sort()).toEqual(['CONFIRMED', 'VEHICLE_BUSY']);
    expect(listAppointments(context.db)).toHaveLength(3);
  });
  it('reconciles simultaneous identical keys to the same appointment', async () => {
    const input = createConfirmationRequest();
    const results = await runBookingRace(context.path, [input, input]);
    expect(results.map(result => result.code)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(listAppointments(context.db)).toHaveLength(3);
  });
});
