import { test, expect } from './runtime.js';
import { type Locator, type Page } from '@playwright/test';
import { customerCatalogSchema } from '../../src/shared/contracts.js';

async function chooseProfile(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^${name}\\b`, 'i') }).click();
  await expect(page.getByRole('button', { name: 'Switch profile', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh times' })).toBeVisible();
}
async function selectDay(page: Page, date: string) {
  await page.getByTestId(`day-${date}`).click();
}
async function selectTime(page: Page, date: string, time: string) {
  await selectDay(page, date);
  await page.getByRole('button', { name: `Start at ${time}`, exact: true }).click();
  await expect(page.getByText('Available for your service', { exact: true })).toBeVisible();
}
async function expectUnavailableTime(page: Page, date: string, time: string, reason: string) {
  await selectDay(page, date);
  const details = page.locator('.unavailable-times');
  await expect(details).toBeVisible();
  if (!(await details.evaluate(element => element.hasAttribute('open')))) await details.locator('summary').click();
  await expect(page.getByTestId('unavailable-slot').filter({ hasText: new RegExp(`^${time}`) })).toContainText(reason);
  await expect(page.getByRole('button', { name: `Start at ${time}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm appointment', exact: true })).toBeDisabled();
}
async function bookAppointment(page: Page, date: string, time = '10:00') {
  await selectTime(page, date, time);
  await page.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
  await expect(page.getByText('You’re booked.', { exact: true })).toBeVisible();
}

async function expectLabeledValue(container: Locator, label: string, value: string) {
  const term = container.locator('dt').filter({ hasText: new RegExp(`^${label}$`) });
  await expect(term).toHaveCount(1);
  await expect(term.locator('..').locator('dd')).toHaveText(value);
}

test('appointment lists and confirmations identify every displayed value', async ({ page, runtime }, testInfo) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto(runtime.url);
  await chooseProfile(page, 'jamie');
  const original = runtime.getAllAppointments().find(appointment => appointment.customerId === 'jamie')!;
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: original.timezone,
  }).format(original.startMs);
  const row = page.getByTestId('appointment');
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('heading')).toHaveText('Service: Oil change');
  for (const [label, value] of [
    ['Customer:', 'Jamie'], ['Vehicle:', 'Green crossover'], ['Vehicle ID:', 'J1'],
    ['Appointment ID:', original.id], ['Date:', date], ['Time:', '09:00-09:30'],
    ['Timezone:', 'UTC+07:00'], ['Dealership:', 'Central Motors'],
    ['Technician:', 'Maya'], ['Service bay:', 'C1'], ['Duration:', '30 minutes'],
  ]) await expectLabeledValue(row, label!, value!);
  await expect(row.getByText('Status: Confirmed', { exact: true })).toBeVisible();
  await row.screenshot({ path: testInfo.outputPath('labeled-appointment.png') });

  await bookAppointment(page, runtime.day);
  const created = runtime.getAllAppointments().find(appointment => appointment.customerId === 'jamie' && appointment.id !== original.id)!;
  const confirmation = page.locator('.confirmation');
  for (const [label, value] of [
    ['Status:', 'Confirmed'], ['Date:', date], ['Time:', '10:00-10:30'],
    ['Timezone:', 'UTC+07:00'], ['Technician:', 'Maya'], ['Service bay:', 'C1'],
    ['Appointment ID:', created.id],
  ]) await expectLabeledValue(confirmation, label!, value!);
  const summary = page.locator('.summary-details');
  await expectLabeledValue(summary, 'Customer', 'Jamie');
  await expectLabeledValue(summary, 'Vehicle', 'Green crossover');
  await expectLabeledValue(summary, 'Vehicle ID', 'J1');
  await expectLabeledValue(summary, 'Dealership', 'Central Motors');
  await expect(page.locator('.summary-card')).toContainText('Duration: 30 minutes');
  await confirmation.screenshot({ path: testInfo.outputPath('labeled-confirmation.png') });
});

test('demo profiles in same-browser tabs, stale-preview rejection and actual process restart', async ({ page, context, runtime }) => {
  await page.goto(runtime.url);
  await chooseProfile(page, 'alex');
  await expect(page.getByText(/Demo day:/)).toHaveCount(0);
  await expect(page.getByText(/Times follow the selected dealership/)).toHaveCount(0);
  await expect(page.getByLabel('Customer', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('appointment')).toHaveCount(0);
  expect(runtime.getAllAppointments()).toHaveLength(2);
  await bookAppointment(page, runtime.day);
  await expect(page.getByTestId('appointment')).toHaveCount(1);
  await expect(page.locator('.confirmation')).toContainText('Maya');
  expect(runtime.getAllAppointments()).toHaveLength(3);
  await page.getByLabel('Vehicle', { exact: true }).selectOption('A2');
  await expectUnavailableTime(page, runtime.day, '09:15', 'All service bays are booked');
  expect(runtime.getAllAppointments()).toHaveLength(3);
  await page.getByLabel('Service', { exact: true }).selectOption('brakes');
  await expectUnavailableTime(page, runtime.day, '09:45', 'All qualified technicians are booked');
  await bookAppointment(page, runtime.day, '10:30');
  await expect(page.getByTestId('appointment')).toHaveCount(2);
  expect(runtime.getAllAppointments()).toHaveLength(4);
  await expectUnavailableTime(page, runtime.nextDay, '11:00', 'No qualified technician has a shift');
  expect(runtime.getAllAppointments()).toHaveLength(4);

  const jamie = await context.newPage();
  const taylor = await context.newPage();
  try {
    for (const [current, name] of [[jamie, 'jamie'], [taylor, 'taylor']] as const) {
      await current.goto(runtime.url);
      await chooseProfile(current, name);
      await current.getByLabel('Service', { exact: true }).selectOption('brakes');
      await selectTime(current, runtime.day, '13:00');
    }
    await jamie.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
    await expect(jamie.getByTestId('appointment')).toHaveCount(2);
    const rejected = taylor.waitForResponse(response => response.url().endsWith('/api/appointments') && response.request().method() === 'POST');
    await taylor.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
    const response = await rejected;
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('TECHNICIAN_BUSY');
    const notice = taylor.getByRole('alertdialog');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('A qualified technician is no longer free');
    await expect(notice).toContainText('No appointment was created.');
    await expect(notice).toContainText(`${runtime.day} at 13:00`);
    await notice.getByRole('button', { name: 'Choose another time' }).click();
    await expect(notice).toHaveCount(0);
    await expect(taylor.locator('#time-picker-heading')).toBeFocused();
    await expect(taylor.getByRole('alert')).toContainText('All qualified technicians');
    await expect(taylor.getByTestId('appointment')).toHaveCount(0);
    expect(runtime.getAllAppointments()).toHaveLength(5);
    await taylor.getByRole('button', { name: 'Switch profile' }).click();
    await chooseProfile(taylor, 'riley');
    await expect(jamie.getByText('Hi, Jamie', { exact: true })).toBeVisible();
    await expect(page.getByText('Hi, Alex', { exact: true })).toBeVisible();
    await jamie.reload();
    await expect(jamie.getByText('Hi, Jamie', { exact: true })).toBeVisible();
    await expect(taylor.getByText('Hi, Riley', { exact: true })).toBeVisible();
    expect(await context.cookies()).toEqual([]);
  } finally { await jamie.close(); await taylor.close(); }

  await page.getByLabel('Vehicle', { exact: true }).selectOption('A2');
  await page.getByLabel('Service', { exact: true }).selectOption('oil');
  await expectUnavailableTime(page, runtime.day, '09:15', 'All service bays are booked');
  await page.getByLabel('Vehicle', { exact: true }).selectOption('A1');
  await page.getByLabel('Dealership', { exact: true }).selectOption('riverside');
  await expectUnavailableTime(page, runtime.day, '10:00', 'This vehicle already has an appointment');
  await page.getByLabel('Dealership', { exact: true }).selectOption('central');
  await page.getByLabel('Service', { exact: true }).selectOption('brakes');
  await expectUnavailableTime(page, runtime.nextDay, '11:00', 'No qualified technician has a shift');
  await page.getByLabel('Service', { exact: true }).selectOption('inspection');
  await expectUnavailableTime(page, runtime.nextDay, '16:30', 'The entire service must fit');
  const before = runtime.getAllAppointments();
  await runtime.restart();
  await page.reload();
  await expect(page.getByText('Hi, Alex', { exact: true })).toBeVisible();
  await expect(page.getByTestId('appointment')).toHaveCount(2);
  expect(runtime.getAllAppointments()).toEqual(before);
});

test('a bay conflict opens a visible responsive dialog and returns keyboard focus to recovery', async ({ page, context, runtime }, testInfo) => {
  await page.goto(runtime.url);
  await chooseProfile(page, 'alex');
  await selectTime(page, runtime.day, '09:30');
  const jamie = await context.newPage();
  try {
    await jamie.setViewportSize({ width: 375, height: 667 });
    await jamie.goto(runtime.url);
    await chooseProfile(jamie, 'jamie');
    await selectTime(jamie, runtime.day, '09:30');
    await page.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
    await expect(page.getByText('You’re booked.', { exact: true })).toBeVisible();
    const rejected = jamie.waitForResponse(response => response.url().endsWith('/api/appointments') && response.request().method() === 'POST');
    await jamie.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
    const response = await rejected;
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('BAY_BUSY');
    const notice = jamie.getByRole('alertdialog');
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('heading')).toHaveText('That time is no longer available');
    await expect(notice).toContainText('A service bay is no longer free for your entire appointment.');
    await expect(notice).toContainText('No appointment was created.');
    await expect(notice).toContainText('Oil change');
    await expect(notice).toContainText('Central Motors');
    await expect(notice).toContainText(`${runtime.day} at 09:30`);
    await expect(notice.getByRole('heading')).toBeFocused();
    await jamie.keyboard.press('Tab');
    await expect(notice.getByRole('button', { name: 'Choose another time' })).toBeFocused();
    await jamie.keyboard.press('Tab');
    await expect(notice.getByRole('button', { name: 'Close booking notice' })).toBeFocused();
    await jamie.keyboard.press('Shift+Tab');
    await expect(notice.getByRole('button', { name: 'Choose another time' })).toBeFocused();
    for (const [width, height] of [[375, 667], [844, 320]]) {
      await jamie.setViewportSize({ width: width!, height: height! });
      const bounds = await notice.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width!);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height!);
      expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await notice.getByRole('button', { name: 'Choose another time' }).scrollIntoViewIfNeeded();
      await expect(notice.getByRole('button', { name: 'Choose another time' })).toBeInViewport();
    }
    expect(await notice.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await notice.locator('.conflict-appointment strong').evaluate(element => { element.textContent = 'LongUnbrokenServiceDescription'.repeat(16); });
    expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await notice.getByRole('button', { name: 'Close booking notice' }).scrollIntoViewIfNeeded();
    await expect(notice.getByRole('button', { name: 'Close booking notice' })).toBeInViewport();
    await notice.locator('.conflict-appointment strong').evaluate(element => { element.textContent = 'Oil change'; });
    await jamie.setViewportSize({ width: 375, height: 667 });
    await notice.evaluate(element => { element.scrollTop = 0; });
    await jamie.screenshot({ path: testInfo.outputPath('booking-conflict-mobile.png') });
    expect(runtime.getAllAppointments()).toHaveLength(3);
    await jamie.keyboard.press('Escape');
    await expect(notice).toHaveCount(0);
    await expect(jamie.locator('#time-picker-heading')).toBeFocused();
    await expect(jamie.getByRole('button', { name: 'Confirm appointment', exact: true })).toBeDisabled();
    await bookAppointment(jamie, runtime.day, '10:00');
    expect(runtime.getAllAppointments()).toHaveLength(4);
  } finally { await jamie.close(); }
});

test('lost confirmation survives restart, reload and profile switching without duplication', async ({ page, runtime }) => {
  await page.goto(runtime.url);
  await chooseProfile(page, 'alex');
  await selectTime(page, runtime.day, '10:00');
  let committedId = '';
  await page.route('**/api/appointments', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committedId = (await response.json()).appointment.id;
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByLabel('Vehicle', { exact: true })).toBeDisabled();
  await page.unroute('**/api/appointments');
  await runtime.restart();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch profile' }).click();
  await chooseProfile(page, 'taylor');
  await expect(page.getByRole('button', { name: 'Retry same request' })).toHaveCount(0);
  await expect(page.getByTestId('appointment')).toHaveCount(0);
  await expect(page.getByLabel('Vehicle', { exact: true }).locator('option')).toHaveText(['T1 · Red wagon']);
  await page.getByRole('button', { name: 'Switch profile' }).click();
  await chooseProfile(page, 'alex');
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(page.locator('.confirmation')).toContainText(committedId);
  await expect(page.getByTestId('appointment')).toHaveCount(1);
  expect(runtime.getAllAppointments()).toHaveLength(3);
});

test('changing inputs discards obsolete availability responses', async ({ page, runtime }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/availability/slots', async route => {
    if (route.request().postDataJSON().serviceId !== 'oil') return route.continue();
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto(runtime.url);
  await chooseProfile(page, 'alex');
  await page.getByLabel('Service', { exact: true }).selectOption('brakes');
  await expectUnavailableTime(page, runtime.day, '09:45', 'All qualified technicians are booked');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByText('Available for your service', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm appointment', exact: true })).toBeDisabled();
});

test('invalid saved profile, validation and refresh failures show explicit errors', async ({ page, runtime }) => {
  await page.addInitScript(() => sessionStorage.setItem('service-studio.demo-profile', 'missing'));
  await page.goto(runtime.url);
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await chooseProfile(page, 'jamie');
  await expect(page.getByTestId('appointment')).toHaveCount(1);
  await page.route('**/api/availability/slots', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Refresh times' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not load times');
  await page.unroute('**/api/availability/slots');
  await page.getByRole('button', { name: 'Refresh times' }).click();
  await expect(page.getByTestId(`day-${runtime.day}`)).toBeVisible();
  await page.route('**/api/appointments', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Refresh appointments' }).click();
  await expect(page.getByText('Could not refresh appointments.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('appointment')).toHaveCount(1);
});

test('long labels reflow and keyboard confirmation works without pointer input', async ({ page, runtime }) => {
  await page.route('**/api/catalog', async route => {
    const response = await route.fetch();
    const data = customerCatalogSchema.parse(await response.json());
    const vehicle = data.vehicles.find(vehicle => vehicle.id === 'A1');
    const service = data.services.find(service => service.id === 'oil');
    if (!vehicle || !service) throw new Error('Demo catalog missing expected items.');
    vehicle.label = 'LongVehicleDescription'.repeat(15);
    service.name = 'LongServiceDescription'.repeat(15);
    await route.fulfill({ response, json: data });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(runtime.url);
  await chooseProfile(page, 'alex');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await selectDay(page, runtime.day);
  await page.getByRole('button', { name: 'Start at 10:00', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Available for your service', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm appointment', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('You’re booked.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('appointment')).toHaveCount(1);
});

test('shows seven days, pages by a week, and clears selected times when inputs change', async ({ page, runtime }) => {
  await page.goto(runtime.url);
  await chooseProfile(page, 'alex');
  await expect(page.locator('.day-button')).toHaveCount(7);
  await expect(page.getByRole('button', { name: 'Previous 7 days' })).toBeDisabled();
  const initial = await page.locator('.day-button').first().getAttribute('data-testid');
  await selectTime(page, runtime.day, '10:00');
  await expect(page.getByRole('button', { name: 'Start at 10:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Next 7 days' }).click();
  await expect(page.locator('.day-button')).toHaveCount(7);
  await expect(page.getByRole('button', { name: 'Previous 7 days' })).toBeEnabled();
  const next = await page.locator('.day-button').first().getAttribute('data-testid');
  expect(Date.parse(next!.slice(4)) - Date.parse(initial!.slice(4))).toBe(7 * 86400000);
  await expect(page.getByRole('button', { name: 'Confirm appointment', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous 7 days' }).click();
  await expect(page.locator('.day-button').first()).toHaveAttribute('data-testid', initial!);
  await selectTime(page, runtime.day, '10:00');
  await page.getByLabel('Vehicle', { exact: true }).selectOption('A2');
  await expect(page.getByRole('button', { name: 'Confirm appointment', exact: true })).toBeDisabled();
  await selectDay(page, runtime.nextDay);
  await expect(page.locator('.time-button[aria-pressed="true"]')).toHaveCount(0);
  const closed = page.locator('.day-button').filter({ hasText: 'Closed' }).first();
  await closed.click();
  await expect(page.getByText('The dealership is closed on this day.')).toBeVisible();
  await expect(page.locator('.time-button')).toHaveCount(0);
  await page.getByLabel('Service', { exact: true }).selectOption('brakes');
  const serviceOptions = await page.getByLabel('Service', { exact: true }).locator('option').allTextContents();
  await page.getByLabel('Dealership', { exact: true }).selectOption('riverside');
  await expect(page.getByLabel('Service', { exact: true })).toHaveValue('brakes');
  await expect(page.getByLabel('Service', { exact: true }).locator('option')).toHaveText(serviceOptions);
});

test('refresh returns to today if the server reports that the selected window has expired', async ({ page, runtime }) => {
  await page.goto(runtime.url);
  await chooseProfile(page, 'alex');
  await expect(page.getByRole('button', { name: 'Next 7 days' })).toBeEnabled();
  await page.route('**/api/availability/slots', route => {
    if (route.request().postDataJSON().startDate) return route.fulfill({
      status: 422, json: { error: { code: 'DATE_IN_PAST', message: 'The availability window cannot start before today at the dealership.', requestId: 'window-expired-test' } },
    });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Next 7 days' }).click();
  await expect(page.getByRole('alert')).toContainText('before today');
  await page.getByRole('button', { name: 'Refresh times' }).click();
  await expect(page.getByTestId(`day-${runtime.day}`)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous 7 days' })).toBeDisabled();
});

for (const theme of ['light', 'dark']) {
  test(`${theme} profile and booking layouts support responsive sizes, contrast and zoom`, async ({ page, runtime }, testInfo) => {
    await page.goto(`${runtime.url}?clawpilotTheme=${theme}`);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('heading', { name: 'Choose a demo profile' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-profiles.png`), fullPage: true });
    await chooseProfile(page, 'jamie');
    await expect(page.getByTestId('appointment')).toHaveCount(1);
    const contrast = await page.locator('.intro').evaluate(element => {
      function calculateLuminance(color: string) {
        const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${color}`);
        return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
      }
      const a = calculateLuminance(getComputedStyle(element).color);
      const b = calculateLuminance(getComputedStyle(document.body).backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    for (const [width, height] of [[375, 812], [744, 900], [1128, 900], [1440, 1000], [844, 390]]) {
      await page.setViewportSize({ width: width!, height: height! });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('.summary-card').scrollIntoViewIfNeeded();
      expect(await page.locator('.summary-card').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.getByTestId('appointment').last().scrollIntoViewIfNeeded();
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`${theme}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`${theme}-desktop.png`), fullPage: true });
    await page.evaluate(() => { document.body.style.zoom = '2'; });
    await page.setViewportSize({ width: 744, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => { document.body.style.zoom = ''; });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Switch profile', exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeInViewport();
  });
}
