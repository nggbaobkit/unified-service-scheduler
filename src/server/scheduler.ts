import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import {
  bookingSchema, confirmationSchema, dealershipSchema, resourceSchema, serviceSchema, slotRequestSchema,
  type Availability, type BookingIntent, type SlotWindow, type TimeSlot,
} from '../shared/contracts.js';
import { getAppointmentById, type Store } from './persistence/database.js';
import { SERVICE_SCHEDULE, type ServiceSchedule, type WorkingPeriod } from './config/workingHours.js';

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

export function resolveLocalTime(local: string, timezone: string): number {
  try {
    return Temporal.PlainDateTime.from(local, { overflow: 'reject' })
      .toZonedDateTime(timezone, { disambiguation: 'reject' }).epochMilliseconds;
  } catch {
    throw new DomainError('INVALID_LOCAL_TIME', 'Choose a valid, unambiguous time in the dealership timezone.', 422);
  }
}

function isWithinWorkingPeriod(intervals: readonly WorkingPeriod[], startMs: number, endMs: number, timezone: string, workingDays: readonly number[]) {
  const local = Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO(timezone);
  if (!workingDays.includes(local.dayOfWeek)) return false;
  return intervals.some(interval => {
    let open: number;
    let close: number;
    try {
      open = resolveLocalTime(`${local.toPlainDate()}T${interval.startTime}`, timezone);
      close = resolveLocalTime(`${local.toPlainDate()}T${interval.endTime}`, timezone);
    } catch {
      throw new DomainError('INVALID_SCHEDULE', 'The dealership schedule needs attention for this date.', 500);
    }
    return startMs >= open && endMs <= close;
  });
}

const resourceIdSchema = z.object({ id: z.string() });

export class Scheduler {
  constructor(
    private db: Store,
    private now: () => number = Date.now,
    private afterInsert?: () => void,
    private readonly schedule: ServiceSchedule = SERVICE_SCHEDULE,
  ) {}

  private resolveBookingContext(intent: Pick<BookingIntent, 'customerId' | 'vehicleId' | 'dealershipId' | 'serviceId'>) {
    if (!this.db.prepare('SELECT 1 FROM vehicles WHERE id = ? AND customerId = ?')
      .get(intent.vehicleId, intent.customerId)) {
      throw new DomainError('VEHICLE_OWNERSHIP', 'Select a vehicle belonging to this customer.', 422);
    }
    const dealership = dealershipSchema.optional().parse(
      this.db.prepare('SELECT * FROM dealerships WHERE id = ?').get(intent.dealershipId));
    const service = serviceSchema.optional().parse(
      this.db.prepare('SELECT * FROM services WHERE id = ?').get(intent.serviceId));
    if (!dealership) throw new DomainError('DEALERSHIP_NOT_FOUND', 'Choose an existing dealership.', 422);
    if (!service) throw new DomainError('SERVICE_NOT_FOUND', 'Choose a service from the service catalog.', 422);
    return { dealership, service };
  }

  private findAvailableResources(intent: BookingIntent, now = this.now()) {
    const { dealership, service } = this.resolveBookingContext(intent);
    
    const startMs = resolveLocalTime(intent.localStart, dealership.timezone);
    const endMs = startMs + service.durationMinutes * 60000;
    if (startMs <= now) throw new DomainError('PAST_START', 'Choose a start time in the future.', 422);
    if (!isWithinWorkingPeriod(this.schedule.openingHours, startMs, endMs, dealership.timezone, this.schedule.workingDays)) {
      throw new DomainError('OUTSIDE_OPENING_HOURS', 'The entire service must fit within dealership opening hours.');
    }

    if (this.db.prepare(
      'SELECT 1 FROM appointments WHERE vehicleId = ? AND startMs < ? AND endMs > ?',
    ).get(intent.vehicleId, endMs, startMs)) {
      throw new DomainError('VEHICLE_BUSY', 'This vehicle already has an appointment during that time.');
    }
    
    const qualified = z.array(resourceSchema).parse(this.db.prepare(`
      SELECT t.* FROM technicians t JOIN qualifications q ON q.technicianId = t.id
      WHERE t.dealershipId = ? AND q.serviceId = ? ORDER BY t.id
    `).all(dealership.id, service.id));
    if (!qualified.length) {
      throw new DomainError('NO_QUALIFIED_TECHNICIAN', 'No technician at this dealership is qualified for this service.');
    }
    if (!isWithinWorkingPeriod(this.schedule.technicianHours, startMs, endMs, dealership.timezone, this.schedule.workingDays)) {
      throw new DomainError('OUTSIDE_TECHNICIAN_SHIFT', 'No qualified technician has a shift covering the whole service, including breaks.');
    }
    const technician = qualified.find(candidate => !this.db.prepare(
      'SELECT 1 FROM appointments WHERE technicianId = ? AND startMs < ? AND endMs > ?',
    ).get(candidate.id, endMs, startMs));
    if (!technician) {
      throw new DomainError('TECHNICIAN_BUSY', 'All qualified technicians are booked during part or all of this service.');
    }

    const bay = resourceIdSchema.optional().parse(this.db.prepare(`
      SELECT b.id FROM bays b WHERE b.dealershipId = ?
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.bayId = b.id AND a.startMs < ? AND a.endMs > ?)
      ORDER BY b.id LIMIT 1
    `).get(dealership.id, endMs, startMs));
    if (!bay) throw new DomainError('BAY_BUSY', 'All service bays are booked during part or all of this service.');
    
    return { technicianId: technician.id, bayId: bay.id, startMs, endMs, durationMinutes: service.durationMinutes, timezone: dealership.timezone };
  }

  previewAvailability(input: unknown): Availability {
    const intent = bookingSchema.parse(input);
    // One read snapshot keeps the advisory checks internally consistent.
    return this.db.transaction(() => {
      try {
        const result = this.findAvailableResources(intent);
        return {
          available: true, code: 'AVAILABLE',
          message: 'A qualified technician and service bay are available for the whole service.',
          startMs: result.startMs, endMs: result.endMs,
          timezone: result.timezone, durationMinutes: result.durationMinutes,
        };
      } catch (error) {
        if (error instanceof DomainError && error.status === 409) {
          return { available: false, code: error.code, message: error.message };
        }
        throw error;
      }
    })();
  }

  getAvailabilityWindow(input: unknown): SlotWindow {
    const request = slotRequestSchema.parse(input);
    return this.db.transaction((): SlotWindow => {
      const now = this.now();
      const { dealership } = this.resolveBookingContext(request);
      const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(dealership.timezone).toPlainDate();
      let start: Temporal.PlainDate;
      try {
        start = request.startDate ? Temporal.PlainDate.from(request.startDate, { overflow: 'reject' }) : today;
        if (start.add({ days: 6 }).year > 9999) throw new Error('Window exceeds supported date range.');
      } catch {
        throw new DomainError('INVALID_DATE', 'Choose a valid start date for a seven-day window.', 422);
      }
      if (Temporal.PlainDate.compare(start, today) < 0) {
        throw new DomainError('DATE_IN_PAST', 'The availability window cannot start before today at the dealership.', 422);
      }
      const days = Array.from({ length: 7 }, (_, index) => {
        const date = start.add({ days: index });
        const intervals = this.schedule.workingDays.includes(date.dayOfWeek) ? this.schedule.openingHours : [];
        const candidates = new Set<number>();
        for (const interval of intervals) {
          let from: Temporal.PlainTime;
          let to: Temporal.PlainTime;
          try {
            from = Temporal.PlainTime.from(interval.startTime, { overflow: 'reject' });
            to = Temporal.PlainTime.from(interval.endTime, { overflow: 'reject' });
            if (Temporal.PlainTime.compare(from, to) >= 0) throw new Error('Invalid opening interval.');
          } catch {
            throw new DomainError('INVALID_SCHEDULE', 'The dealership opening hours need attention.', 500);
          }
          for (let minute = Math.ceil((from.hour * 60 + from.minute) / 15) * 15; minute < to.hour * 60 + to.minute; minute += 15) {
            candidates.add(minute);
          }
        }
        const slots: TimeSlot[] = [...candidates].sort((a, b) => a - b).map(minute => {
          const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
          const localStart = `${date}T${time}`;
          try {
            const result = this.findAvailableResources({ ...request, localStart }, now);
            return {
              available: true, code: 'AVAILABLE', message: 'A qualified technician and service bay are available for the whole service.',
              localStart, time, startMs: result.startMs, endMs: result.endMs,
              durationMinutes: result.durationMinutes, timezone: result.timezone,
            };
          } catch (error) {
            if (error instanceof DomainError && (error.status === 409 || ['PAST_START', 'INVALID_LOCAL_TIME'].includes(error.code))) {
              return { available: false, code: error.code, message: error.message, localStart, time };
            }
            throw error;
          }
        });
        return { date: date.toString(), closed: intervals.length === 0, slots };
      });
      const previous = start.subtract({ days: 7 });
      const next = start.add({ days: 7 });
      return {
        timezone: dealership.timezone, today: today.toString(),
        startDate: start.toString(), endDate: start.add({ days: 6 }).toString(),
        previousStartDate: Temporal.PlainDate.compare(start, today) === 0 ? null
          : (Temporal.PlainDate.compare(previous, today) < 0 ? today : previous).toString(),
        nextStartDate: next.add({ days: 6 }).year > 9999 ? null : next.toString(),
        intervalMinutes: 15, days,
      };
    })();
  }

  confirmAppointment(input: unknown) {
    const request = confirmationSchema.parse(input);
    const { idempotencyKey, ...intent } = request;
    const fingerprint = JSON.stringify(intent);
    // Lock BEFORE checking availability. All booking writes use this boundary.
    return this.db.transaction(() => {
      const existing = z.object({ id: z.string(), customerId: z.string(), fingerprint: z.string() }).optional().parse(
        this.db.prepare('SELECT id, customerId, fingerprint FROM appointments WHERE idempotencyKey = ?').get(idempotencyKey),
      );
      if (existing) {
        if (existing.customerId !== intent.customerId || existing.fingerprint !== fingerprint) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'This request key belongs to a different booking. Start a new request.');
        }
        return { appointment: getAppointmentById(this.db, existing.id), replayed: true };
      }

      const availableResources = this.findAvailableResources(intent);
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO appointments
        (id, customerId, vehicleId, dealershipId, serviceId, technicianId, bayId,
         startMs, endMs, durationMinutes, createdAt, idempotencyKey, fingerprint)
        VALUES (@id, @customerId, @vehicleId, @dealershipId, @serviceId, @technicianId, @bayId,
          @startMs, @endMs, @durationMinutes, @createdAt, @idempotencyKey, @fingerprint)
      `).run({ ...intent, ...availableResources, id, createdAt: this.now(), idempotencyKey, fingerprint });
      this.afterInsert?.();
      return { appointment: getAppointmentById(this.db, id), replayed: false };
    }).immediate();
  }
}
