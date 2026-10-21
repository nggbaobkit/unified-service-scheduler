export type WorkingPeriod = {
  readonly startTime: string;
  readonly endTime: string;
};

export type ServiceSchedule = {
  readonly workingDays: readonly number[];
  readonly openingHours: readonly WorkingPeriod[];
  readonly technicianHours: readonly WorkingPeriod[];
};

// One fixed calendar for every dealership and technician, in each dealership's local timezone.
export const SERVICE_SCHEDULE: ServiceSchedule = {
  workingDays: [1, 2, 3, 4, 5],
  openingHours: [{ startTime: '09:00', endTime: '17:00' }],
  technicianHours: [
    { startTime: '09:00', endTime: '12:00' },
    { startTime: '13:00', endTime: '17:00' },
  ],
};
