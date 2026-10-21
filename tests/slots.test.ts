import { afterEach, beforeEach, expect, it } from 'vitest';
import supertest from 'supertest';
import { slotWindowSchema } from '../src/shared/contracts.js';
import { Scheduler } from '../src/server/scheduler.js';
import { createApp } from '../src/server/app.js';
import { listAppointments } from '../src/server/persistence/database.js';
import { SERVICE_SCHEDULE } from '../src/server/config/workingHours.js';
import { day, createTestFixture, createBookingIntent, now, createConfirmationRequest } from './fixtures.js';

let context: ReturnType<typeof createTestFixture>;
let scheduler: Scheduler;
beforeEach(() => { context = createTestFixture(); scheduler = new Scheduler(context.db, () => now); });
afterEach(() => context.dispose());
function createSlotRequest(extra = {}) {
  const { localStart: _start, ...selected } = createBookingIntent();
  return { ...selected, ...extra };
}

it('returns exactly seven days of quarter-hour starts with complete service windows', () => {
  const result = slotWindowSchema.parse(scheduler.getAvailabilityWindow(createSlotRequest()));
  expect(result).toMatchObject({
    today: '2030-01-06', startDate: '2030-01-06', endDate: '2030-01-12',
    previousStartDate: null, nextStartDate: '2030-01-13', intervalMinutes: 15, timezone: 'Asia/Ho_Chi_Minh',
  });
  expect(result.days).toHaveLength(7);
  const monday = result.days.find(value => value.date === day)!;
  expect(monday.slots).toHaveLength(32);
  expect(monday.slots[0]?.time).toBe('09:00');
  expect(monday.slots.at(-1)?.time).toBe('16:45');
  expect(monday.slots.every(slot => Number(slot.time.slice(3)) % 15 === 0)).toBe(true);
  for (const slot of monday.slots.filter(slot => slot.available)) {
    expect(slot.endMs! - slot.startMs!).toBe(30 * 60000);
    expect(scheduler.previewAvailability({ ...createBookingIntent(), localStart: slot.localStart }).available).toBe(true);
  }
  expect(result.days[0]).toMatchObject({ closed: true, slots: [] });
  expect(listAppointments(context.db)).toHaveLength(2);
});

it('uses the same bay, qualification, full-shift, closing and vehicle rules as confirmation', () => {
  const oil = scheduler.getAvailabilityWindow(createSlotRequest({ startDate: day })).days[0]!;
  expect(oil.slots.find(slot => slot.time === '09:15')).toMatchObject({ available: false, code: 'BAY_BUSY' });
  expect(oil.slots.find(slot => slot.time === '16:45')).toMatchObject({ available: false, code: 'OUTSIDE_OPENING_HOURS' });
  const brakes = scheduler.getAvailabilityWindow(createSlotRequest({ startDate: day, serviceId: 'brakes', vehicleId: 'A2' })).days[0]!;
  expect(brakes.slots.find(slot => slot.time === '09:45')).toMatchObject({ available: false, code: 'TECHNICIAN_BUSY' });
  expect(brakes.slots.find(slot => slot.time === '10:30')).toMatchObject({ available: true, durationMinutes: 90 });
  expect(brakes.slots.find(slot => slot.time === '11:00')).toMatchObject({ available: false, code: 'OUTSIDE_TECHNICIAN_SHIFT' });
  scheduler.confirmAppointment(createConfirmationRequest());
  const riverside = scheduler.getAvailabilityWindow(createSlotRequest({ startDate: day, dealershipId: 'riverside' })).days[0]!;
  expect(riverside.slots.find(slot => slot.time === '10:00')).toMatchObject({ available: false, code: 'VEHICLE_BUSY' });
});

it('pages by seven days, clamps the previous window to today and validates dates', () => {
  const result = scheduler.getAvailabilityWindow(createSlotRequest({ startDate: '2030-01-13' }));
  expect(result).toMatchObject({ startDate: '2030-01-13', endDate: '2030-01-19', previousStartDate: '2030-01-06', nextStartDate: '2030-01-20' });
  expect(scheduler.getAvailabilityWindow(createSlotRequest({ startDate: day })).previousStartDate).toBe('2030-01-06');
  for (const date of ['2030-02-30', '9999-12-31']) {
    expect(() => scheduler.getAvailabilityWindow(createSlotRequest({ startDate: date }))).toThrow('valid start date');
  }
  expect(() => scheduler.getAvailabilityWindow(createSlotRequest({ startDate: '2030-01-05' }))).toThrow('before today');
});

it('uses dealership-local today and marks already-started times unavailable', () => {
  const early = new Scheduler(context.db, () => Date.parse('2030-01-06T20:00:00Z'));
  expect(early.getAvailabilityWindow(createSlotRequest()).today).toBe('2030-01-07');
  const laterNow = Date.parse('2030-01-07T02:10:00Z');
  const later = new Scheduler(context.db, () => laterNow).getAvailabilityWindow(createSlotRequest());
  expect(later.days[0]!.slots.find(slot => slot.time === '09:00')).toMatchObject({ available: false, code: 'PAST_START' });
  expect(later.days[0]!.slots.filter(slot => slot.available).every(slot => slot.startMs! > laterNow)).toBe(true);
});

it('reports closed weeks without hiding invalid ownership or catalog references', () => {
  const closed = new Scheduler(context.db, () => now, undefined, { ...SERVICE_SCHEDULE, openingHours: [] });
  expect(closed.getAvailabilityWindow(createSlotRequest()).days.every(date => date.closed && date.slots.length === 0)).toBe(true);
  expect(() => closed.getAvailabilityWindow(createSlotRequest({ vehicleId: 'J1' }))).toThrow('belonging to this customer');
  expect(() => closed.getAvailabilityWindow(createSlotRequest({ serviceId: 'missing' }))).toThrow('service catalog');
});

it.each(['2030-03-10', '2030-11-03'])('marks DST gaps/folds unavailable without duplicate selectable instants on %s', date => {
  context.db.exec("UPDATE dealerships SET timezone='America/New_York' WHERE id='central'");
  const extended = new Scheduler(context.db, () => now, undefined, {
    ...SERVICE_SCHEDULE, workingDays: [...SERVICE_SCHEDULE.workingDays, 7],
    openingHours: [{ startTime: '00:00', endTime: '04:00' }],
    technicianHours: [{ startTime: '00:00', endTime: '04:00' }],
  });
  const slots = extended.getAvailabilityWindow(createSlotRequest({ startDate: date })).days[0]!.slots;
  expect(slots.filter(slot => slot.code === 'INVALID_LOCAL_TIME')).toHaveLength(4);
  const available = slots.filter(slot => slot.available);
  expect(new Set(available.map(slot => slot.startMs)).size).toBe(available.length);
  expect(available.every(slot => slot.endMs! - slot.startMs! === 30 * 60000)).toBe(true);
});

it('deduplicates starts when configured opening intervals overlap', () => {
  const overlapping = new Scheduler(context.db, () => now, undefined, {
    ...SERVICE_SCHEDULE, openingHours: [...SERVICE_SCHEDULE.openingHours, { startTime: '09:15', endTime: '11:00' }],
  });
  const slots = overlapping.getAvailabilityWindow(createSlotRequest({ startDate: day })).days[0]!.slots;
  expect(slots).toHaveLength(32);
  expect(new Set(slots.map(slot => slot.localStart)).size).toBe(32);
});

it.each(['central', 'riverside'])('applies the shared opening hours and lunch break at %s', dealershipId => {
  const result = scheduler.getAvailabilityWindow(createSlotRequest({ dealershipId, startDate: '2030-01-08' }));
  const slots = result.days[0]!.slots;
  expect(slots.find(slot => slot.time === '09:00')).toMatchObject({ available: true });
  expect(slots.find(slot => slot.time === '11:30')).toMatchObject({ available: true });
  for (const time of ['11:45', '12:00', '12:15', '12:30', '12:45']) {
    expect(slots.find(slot => slot.time === time)).toMatchObject({ available: false, code: 'OUTSIDE_TECHNICIAN_SHIFT' });
  }
  expect(slots.find(slot => slot.time === '13:00')).toMatchObject({ available: true });
  expect(slots.find(slot => slot.time === '16:30')).toMatchObject({ available: true });
  expect(slots.find(slot => slot.time === '16:45')).toMatchObject({ available: false, code: 'OUTSIDE_OPENING_HOURS' });
  expect(result.days.find(day => day.date === '2030-01-12')).toMatchObject({ closed: true, slots: [] });
});

it('exposes one bounded, validated API response scoped to the selected demo profile', async () => {
  const http = supertest(createApp(context.db, { now: () => now, logger: () => {} }));
  const { customerId: _customer, ...body } = createSlotRequest();
  await http.post('/api/availability/slots').send(body).expect(400);
  const response = await http.post('/api/availability/slots').set('X-Demo-Customer', 'alex').send(body).expect(200);
  expect(response.headers['x-demo-customer']).toBe('alex');
  expect(slotWindowSchema.parse(response.body).days).toHaveLength(7);
  await http.post('/api/availability/slots').set('X-Demo-Customer', 'alex').send({ ...body, days: 365 }).expect(422);
  await http.post('/api/availability/slots').set('X-Demo-Customer', 'alex').send({ ...body, customerId: 'jamie' }).expect(422);
});
