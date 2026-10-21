import { z } from 'zod';

const id = z.string().trim().min(1).max(100);
export const bookingSchema = z.object({
  customerId: id,
  vehicleId: id,
  dealershipId: id,
  serviceId: id,
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use a date and time with minute precision.'),
}).strict();
export const confirmationSchema = bookingSchema.extend({ idempotencyKey: z.uuid() });
export type BookingIntent = z.infer<typeof bookingSchema>;
export type ConfirmationRequest = z.infer<typeof confirmationSchema>;
export const httpBookingSchema = bookingSchema.omit({ customerId: true });
export const httpConfirmationSchema = httpBookingSchema.extend({ idempotencyKey: z.uuid() });
export type HttpBookingIntent = z.infer<typeof httpBookingSchema>;
export type HttpConfirmationRequest = z.infer<typeof httpConfirmationSchema>;
export const slotRequestSchema = bookingSchema.omit({ localStart: true }).extend({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export const httpSlotRequestSchema = slotRequestSchema.omit({ customerId: true });

export const customerSchema = z.object({ id, name: z.string() });
export const vehicleSchema = z.object({ id, customerId: id, label: z.string() });
export const dealershipSchema = z.object({ id, name: z.string(), timezone: z.string() });
export const serviceSchema = z.object({ id, name: z.string(), durationMinutes: z.number().int().positive() });
export const resourceSchema = z.object({ id, dealershipId: id, name: z.string() });
export const catalogSchema = z.object({
  customers: z.array(customerSchema),
  vehicles: z.array(vehicleSchema),
  dealerships: z.array(dealershipSchema),
  services: z.array(serviceSchema),
  bays: z.array(resourceSchema),
  technicians: z.array(resourceSchema),
  qualifications: z.array(z.object({ technicianId: id, serviceId: id })),
  demoDate: z.string().nullable(),
  nextDemoDate: z.string().nullable(),
});
export type Catalog = z.infer<typeof catalogSchema>;
export const customerCatalogSchema = catalogSchema.omit({ customers: true }).extend({ customer: customerSchema });
export type CustomerCatalog = z.infer<typeof customerCatalogSchema>;

export const appointmentSchema = z.object({
  id,
  customerId: id,
  customerName: z.string(),
  vehicleId: id,
  vehicleLabel: z.string(),
  dealershipId: id,
  dealershipName: z.string(),
  timezone: z.string(),
  serviceId: id,
  serviceName: z.string(),
  durationMinutes: z.number(),
  technicianId: id,
  technicianName: z.string(),
  bayId: id,
  bayName: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  createdAt: z.number(),
});
export type Appointment = z.infer<typeof appointmentSchema>;
export const availabilitySchema = z.object({
  available: z.boolean(),
  code: z.string(),
  message: z.string(),
  startMs: z.number().optional(),
  endMs: z.number().optional(),
  timezone: z.string().optional(),
  durationMinutes: z.number().optional(),
});
export type Availability = z.infer<typeof availabilitySchema>;
export const timeSlotSchema = availabilitySchema.extend({ localStart: z.string(), time: z.string() });
export type TimeSlot = z.infer<typeof timeSlotSchema>;
export const slotWindowSchema = z.object({
  timezone: z.string(),
  today: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  previousStartDate: z.string().nullable(),
  nextStartDate: z.string().nullable(),
  intervalMinutes: z.literal(15),
  days: z.array(z.object({
    date: z.string(),
    closed: z.boolean(),
    slots: z.array(timeSlotSchema).max(96),
  })).length(7),
});
export type SlotWindow = z.infer<typeof slotWindowSchema>;
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }),
});
