import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/server/persistence/database.js';
import { seedDemo } from '../src/server/persistence/seed.js';
import type { BookingIntent } from '../src/shared/contracts.js';

export const now = Date.parse('2030-01-06T00:00:00Z');
export const day = '2030-01-07';
export function createBookingIntent(overrides: Partial<BookingIntent> = {}): BookingIntent {
  return { customerId: 'alex', vehicleId: 'A1', dealershipId: 'central', serviceId: 'oil', localStart: `${day}T10:00`, ...overrides };
}
export function createConfirmationRequest(overrides: Partial<BookingIntent> = {}) { return { ...createBookingIntent(overrides), idempotencyKey: randomUUID() }; }

export function createTestFixture() {
  mkdirSync(resolve('.data'), { recursive: true });
  const directory = mkdtempSync(resolve('.data/unit-'));
  const path = join(directory, 'test.sqlite');
  const db = openDatabase(path);
  seedDemo(db, day, now);
  return {
    directory, path, db,
    dispose() { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
