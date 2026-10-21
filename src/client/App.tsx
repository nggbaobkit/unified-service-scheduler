import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  appointmentSchema, customerCatalogSchema, httpConfirmationSchema, customerSchema,
  type Appointment, type Availability, type HttpBookingIntent, type CustomerCatalog, type HttpConfirmationRequest, type TimeSlot,
} from '../shared/contracts.js';
import { requestApi, ApiError } from './api.js';
import { TimePicker } from './TimePicker.js';
import { BookingConflictDialog, getConflictExplanation, type BookingConflict } from './BookingConflictDialog.js';

const confirmationResult = z.object({ appointment: appointmentSchema, replayed: z.boolean() });
const emptyIntent: HttpBookingIntent = { vehicleId: '', dealershipId: '', serviceId: '', localStart: '' };
type Customer = z.infer<typeof customerSchema>;
const selectedProfileKey = 'service-studio.demo-profile';

function formatDate(ms: number, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone }).format(ms);
}
function formatTime(ms: number, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(ms);
}
function formatUtcOffset(ms: number, timezone: string) {
  const part = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(ms).find(part => part.type === 'timeZoneName')?.value;
  return part?.replace('GMT', 'UTC') ?? timezone;
}
function getErrorMessage(error: unknown) { return error instanceof Error ? error.message : 'An unexpected error occurred.'; }
function Mark({ kind = 'car' }: { kind?: 'car' | 'check' | 'clock' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    {kind === 'car' ? <><path d="m5 10 2-5h10l2 5M4 10h16v8H4zM7 18v2m10-2v2M7 13h2m6 0h2" /><path d="M3 10H2m20 0h-1" /></>
      : kind === 'check' ? <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>
        : <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>}
  </svg>;
}

export function App() {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [profiles, setProfiles] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const activeCustomer = useRef<Customer | null>(null);
  activeCustomer.current = customer;

  useEffect(() => {
    let active = true;
    setLoading(true);
    async function loadProfiles() {
      try {
        const available = await requestApi('profiles', z.array(customerSchema));
        if (!active) return;
        setProfiles(available);
        const saved = sessionStorage.getItem(selectedProfileKey);
        const selected = available.find(profile => profile.id === saved);
        if (saved && !selected) {
          sessionStorage.removeItem(selectedProfileKey);
          setError('Your previous demo profile is no longer available. Choose another profile.');
        }
        setCustomer(selected ?? null);
      } catch (error) {
        if (active) { setCustomer(null); setError(`Could not open the demo profiles. ${getErrorMessage(error)}`); }
      } finally { if (active) setLoading(false); }
    }
    function handleProfileUnavailable(event: Event) {
      const detail = event instanceof CustomEvent ? z.object({ customerId: z.string().optional() }).safeParse(event.detail) : null;
      if (detail?.success && detail.data.customerId && detail.data.customerId !== activeCustomer.current?.id) return;
      try { sessionStorage.removeItem(selectedProfileKey); }
      catch (error) { setError(`Could not clear this tab's profile selection. ${getErrorMessage(error)}`); setCustomer(null); return; }
      setCustomer(null);
      setError('That demo profile is no longer available. Choose another profile.');
      setLoadAttempt(value => value + 1);
    }
    void loadProfiles();
    window.addEventListener('profile-unavailable', handleProfileUnavailable);
    return () => { active = false; window.removeEventListener('profile-unavailable', handleProfileUnavailable); };
  }, [loadAttempt]);

  function chooseProfile(profile: Customer) {
    try {
      sessionStorage.setItem(selectedProfileKey, profile.id);
      setCustomer(profile);
      setError('');
    } catch (error) { setError(`Could not remember the profile in this tab. ${getErrorMessage(error)}`); }
  }
  function switchProfile() {
    try {
      sessionStorage.removeItem(selectedProfileKey);
      setCustomer(null);
      setError('');
    } catch (error) { setError(`Could not switch this tab's profile. ${getErrorMessage(error)}`); }
  }
  if (loading) return <main><div className="loading-state" role="status">Opening your service workspace...</div></main>;
  if (customer) return <BookingWorkspace key={customer.id} customer={customer} switchProfile={switchProfile} profileError={error} />;
  return <main className="profile-page">
    <div className="profile-brand"><Mark /><span>service studio</span></div>
    <section className="profile-card" aria-labelledby="profile-heading">
      <p className="eyebrow">A little care. A smoother road.</p>
      <h1 id="profile-heading">Choose a demo profile</h1>
      <p className="intro">Step into a sample customer’s service workspace.</p>
      <div className="profile-list">{profiles.map(profile => <button className="profile-choice" key={profile.id} onClick={() => chooseProfile(profile)}>
        <span className="profile-avatar" aria-hidden="true">{profile.name.slice(0, 1)}</span>
        <span><strong>{profile.name}</strong><span className="profile-description">View vehicles and appointments</span></span>
        <span className="profile-arrow" aria-hidden="true">↗</span>
      </button>)}</div>
      {!profiles.length && !error && <div className="notice">No demo profiles yet. Run the sample-data preparation command and reload.</div>}
      {error && <div role="alert" className="notice error">{error}<button className="secondary" onClick={() => setLoadAttempt(value => value + 1)}>Reload profiles</button></div>}
      <p className="summary-footnote">Demo selection, not secure sign-in. All profiles are fictional and available to anyone. Your selection stays in this tab.</p>
    </section>
  </main>;
}

function BookingWorkspace({ customer, switchProfile, profileError }: {
  customer: Customer; switchProfile: () => void; profileError: string;
}) {
  const pendingKey = `service-studio.pending-booking.${customer.id}`;
  const [data, setData] = useState<CustomerCatalog | null>(null);
  const [intent, setIntent] = useState<HttpBookingIntent>(emptyIntent);
  const [ledger, setLedger] = useState<Appointment[]>([]);
  const [preview, setPreview] = useState<Availability | null>(null);
  const [confirmed, setConfirmed] = useState<Appointment | null>(null);
  const [conflict, setConflict] = useState<BookingConflict | null>(null);
  const [pending, setPending] = useState<HttpConfirmationRequest | null>(null);
  const [error, setError] = useState('');
  const [ledgerError, setLedgerError] = useState('');
  const [timesRevision, setTimesRevision] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [view, setView] = useState<'book' | 'appointments'>('book');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'light');
  const confirmGuard = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([requestApi('catalog', customerCatalogSchema, undefined, customer.id), requestApi('appointments', z.array(appointmentSchema), undefined, customer.id)])
      .then(([catalog, appointments]) => {
        const raw = sessionStorage.getItem(pendingKey);
        const stored = raw ? httpConfirmationSchema.parse(JSON.parse(raw)) : null;
        if (!active) return;
        setData(catalog);
        setLedger(appointments);
        const dealer = catalog.dealerships[0];
        setIntent(stored ? {
          vehicleId: stored.vehicleId, dealershipId: stored.dealershipId,
          serviceId: stored.serviceId, localStart: stored.localStart,
        } : {
          vehicleId: catalog.vehicles[0]?.id ?? '',
          dealershipId: dealer?.id ?? '',
          serviceId: catalog.services[0]?.id ?? '',
          localStart: '',
        });
        setPending(stored);
      })
      .catch(error => { if (active) setError(`Could not load the workspace or saved retry request. ${getErrorMessage(error)}`); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadAttempt, customer.id, pendingKey]);

  async function refreshLedger() {
    try {
      setLedger(await requestApi('appointments', z.array(appointmentSchema), undefined, customer.id));
      setLedgerError('');
    } catch (error) { setLedgerError(`Could not refresh appointments. ${getErrorMessage(error)}`); }
  }

  function updateBookingIntent(values: Partial<HttpBookingIntent>) {
    setIntent(current => ({ ...current, localStart: '', ...values }));
    setPreview(null);
    setConfirmed(null);
    setError('');
  }

  function selectTime(slot: TimeSlot | null) {
    setIntent(current => ({ ...current, localStart: slot?.localStart ?? '' }));
    setPreview(slot);
    setConfirmed(null);
    setError('');
  }

  async function confirmBooking() {
    if (confirmGuard.current || (!pending && !preview?.available)) return;
    confirmGuard.current = true;
    setSubmitting(true);
    setError('');
    let request: HttpConfirmationRequest | null = pending;
    try {
      request ??= { ...intent, idempotencyKey: crypto.randomUUID() };
      sessionStorage.setItem(pendingKey, JSON.stringify(request));
      setPending(request);
      const result = await requestApi('appointments', confirmationResult, request, customer.id);
      setConfirmed(result.appointment);
      setPreview(null);
      try {
        sessionStorage.removeItem(pendingKey);
      } catch (storageError) {
        setError(`Your appointment is confirmed, but the local retry record could not be cleared. ${getErrorMessage(storageError)}`);
      }
      setPending(null);
      setTimesRevision(value => value + 1);
      await refreshLedger();
    } catch (error) {
      setError(getErrorMessage(error));
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && !['PROFILE_REQUIRED', 'PROFILE_NOT_FOUND'].includes(error.code)) {
        try {
          sessionStorage.removeItem(pendingKey);
          setPending(null);
        } catch (storageError) {
          setError(`${getErrorMessage(error)} Could not clear the saved request: ${getErrorMessage(storageError)}`);
        }
        const explanation = getConflictExplanation(error.code);
        if (explanation && request) {
          const failedRequest = request;
          setConflict({
            ...explanation,
            service: data?.services.find(item => item.id === failedRequest.serviceId)?.name ?? failedRequest.serviceId,
            dealership: data?.dealerships.find(item => item.id === failedRequest.dealershipId)?.name ?? failedRequest.dealershipId,
            timezone: data?.dealerships.find(item => item.id === failedRequest.dealershipId)?.timezone ?? '',
            localStart: failedRequest.localStart,
          });
        }
        if (error.status === 409 || explanation) {
          setPreview(null);
          setIntent(current => ({ ...current, localStart: '' }));
          setTimesRevision(value => value + 1);
          await refreshLedger();
        }
      }
    } finally {
      confirmGuard.current = false;
      setSubmitting(false);
    }
  }

  const dealer = data?.dealerships.find(item => item.id === intent.dealershipId);
  const service = data?.services.find(item => item.id === intent.serviceId);
  const vehicle = data?.vehicles.find(item => item.id === intent.vehicleId);
  const locked = submitting || pending !== null;

  return <>
    {conflict && <BookingConflictDialog conflict={conflict} onDismiss={() => {
      setConflict(null);
      requestAnimationFrame(() => document.getElementById('time-picker-heading')?.focus());
    }} />}
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header">
      <a className="brand" href="#main" onClick={() => setView('book')}><Mark /><span>service<span className="brand-light">studio</span></span></a>
      <nav aria-label="Main navigation">
        <button className={view === 'book' ? 'nav-button active' : 'nav-button'} aria-current={view === 'book' ? 'page' : undefined} onClick={() => setView('book')}>Book a service</button>
        <button className={view === 'appointments' ? 'nav-button active' : 'nav-button'} aria-current={view === 'appointments' ? 'page' : undefined} onClick={() => { setView('appointments'); void refreshLedger(); }}>My appointments <span className="count">{ledger.length}</span></button>
      </nav>
      <div className="profile-controls"><span>Hi, {customer.name}</span><button className="secondary" disabled={submitting} onClick={switchProfile}>Switch profile</button>
      <button className="theme-button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={() => {
        const next = theme === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = next;
        setTheme(next);
      }}>{theme === 'light' ? 'Dark' : 'Light'} mode</button></div>
    </header>
    <main id="main">
      <div className="page-heading">
        <div><p className="eyebrow">A little care. A smoother road.</p><h1>{view === 'book' ? 'Your next service, sorted.' : 'Your appointments, in one place.'}</h1>
          <p className="intro">{view === 'book' ? 'Find the right time. We’ll take care of the right people and space.' : 'Confirmed bookings, assigned resources, and the details that matter.'}</p></div>
        <span className="sample-badge"><span className="sample-dot" />Local sample workspace</span>
      </div>
      {profileError && <div className="notice error" role="alert">{profileError}</div>}
      {loading ? <div className="loading-state" role="status">Loading your service workspace...</div>
        : !data ? <div className="notice error" role="alert">{error}<button className="secondary" onClick={() => setLoadAttempt(value => value + 1)}>Retry loading</button></div>
          : !data.vehicles.length ? <div className="notice" role="status"><h2>No vehicles are linked to this profile.</h2><p>Contact the local workspace operator to check your sample data.</p></div>
            : <>
              {view === 'book' && <>
                  <fieldset disabled={locked} className="search-surface">
                    <legend className="sr-only">Choose your service appointment</legend>
                    <label className="search-segment">Dealership
                      <select aria-label="Dealership" value={intent.dealershipId} onChange={event => {
                        updateBookingIntent({ dealershipId: event.target.value });
                      }}>{data.dealerships.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                    </label>
                    <label className="search-segment">Service
                      <select aria-label="Service" value={intent.serviceId} onChange={event => updateBookingIntent({ serviceId: event.target.value })}>
                        {data.services.map(item => <option key={item.id} value={item.id}>{item.name} · {item.durationMinutes} min</option>)}
                      </select>
                    </label>
                  </fieldset>
                <div className="booking-layout">
                  <section className="booking-detail" aria-labelledby="vehicle-heading">
                    <div className="section-title"><span className="step-number">01</span><div><h2 id="vehicle-heading">Which vehicle needs a little care?</h2><p>Choose from your vehicles. We’ll handle the rest.</p></div></div>
                    <fieldset disabled={locked} className="customer-fields"><legend className="sr-only">My vehicles</legend>
                      <label>Vehicle<select aria-label="Vehicle" value={intent.vehicleId} onChange={event => updateBookingIntent({ vehicleId: event.target.value })}>{data.vehicles.map(item => <option key={item.id} value={item.id}>{item.id} · {item.label}</option>)}</select></label>
                    </fieldset>
                    <div className="vehicle-tile"><div className="vehicle-symbol"><Mark /></div><div><strong>{vehicle?.label}</strong><p>{vehicle?.id} · {customer?.name}’s vehicle</p></div><span className="quiet-tag">Selected</span></div>
                    <div className="divider" />
                    {service && <TimePicker key={`${intent.dealershipId}:${intent.serviceId}:${intent.vehicleId}`}
                      customerId={customer.id} vehicleId={intent.vehicleId} dealershipId={intent.dealershipId} serviceId={intent.serviceId}
                      duration={service.durationMinutes} preferredDate={data.demoDate} selectedStart={intent.localStart}
                      locked={locked} refreshKey={timesRevision} onSelect={selectTime} />}
                  </section>
                  <aside className="summary-card" aria-labelledby="summary-heading">
                    <p className="eyebrow">Your appointment</p><h2 id="summary-heading"><span className="field-label">Service:</span> {confirmed?.serviceName ?? service?.name}</h2>
                    <p className="duration"><Mark kind="clock" />Duration: {confirmed?.durationMinutes ?? service?.durationMinutes} minutes</p>
                    <dl className="summary-details">
                      <div><dt>Customer</dt><dd>{confirmed?.customerName ?? customer.name}</dd></div>
                      <div><dt>Vehicle</dt><dd>{confirmed?.vehicleLabel ?? vehicle?.label}</dd></div>
                      <div><dt>Vehicle ID</dt><dd>{confirmed?.vehicleId ?? vehicle?.id}</dd></div>
                      <div><dt>Dealership</dt><dd>{confirmed?.dealershipName ?? dealer?.name}</dd></div>
                      <div><dt>Requested start</dt><dd>{intent.localStart ? intent.localStart.replace('T', ' at ') : 'Choose a time'}</dd></div>
                      <div><dt>Timezone</dt><dd>{dealer?.timezone}</dd></div>
                      {preview?.available && preview.startMs && preview.endMs && preview.timezone ? <div><dt>Service window</dt><dd>{formatTime(preview.startMs, preview.timezone)}-{formatTime(preview.endMs, preview.timezone)} ({formatUtcOffset(preview.startMs, preview.timezone)})</dd></div> : null}
                    </dl>
                    <div aria-live="polite" aria-atomic="true">
                      {preview && <div className={`notice ${preview.available ? 'available' : 'unavailable'}`}><strong>{preview.available ? 'Available for your service' : 'That time won’t work'}</strong><p>{preview.message}</p></div>}
                      {!preview && !confirmed && !pending && <p className="preview-hint">Choose an available time to see your full service window.</p>}
                      {pending && !submitting && <div className="notice"><strong>Let’s reconcile your request</strong><p>A confirmation may already exist. Retry the saved request before changing details. Retrying will not create a second appointment.</p></div>}
                    </div>
                    {error && <div className="notice error" role="alert">{error}</div>}
                    {!confirmed && <button className="primary confirm-button" type="button" disabled={submitting || (!pending && !preview?.available)} onClick={() => void confirmBooking()}>{submitting ? 'Confirming...' : pending ? 'Retry same request' : 'Confirm appointment'}</button>}
                    {confirmed && <div className="confirmation" role="status">
                      <Mark kind="check" /><h3>You’re booked.</h3>
                      <dl className="confirmation-fields">
                        <div><dt>Status:</dt><dd>Confirmed</dd></div>
                        <div><dt>Date:</dt><dd>{formatDate(confirmed.startMs, confirmed.timezone)}</dd></div>
                        <div><dt>Time:</dt><dd>{formatTime(confirmed.startMs, confirmed.timezone)}-{formatTime(confirmed.endMs, confirmed.timezone)}</dd></div>
                        <div><dt>Timezone:</dt><dd>{formatUtcOffset(confirmed.startMs, confirmed.timezone)}</dd></div>
                        <div><dt>Technician:</dt><dd>{confirmed.technicianName}</dd></div>
                        <div><dt>Service bay:</dt><dd>{confirmed.bayName}</dd></div>
                        <div><dt>Appointment ID:</dt><dd className="reference">{confirmed.id}</dd></div>
                      </dl>
                    </div>}
                    <p className="summary-footnote">Availability is a preview, not a hold. We recheck everything when you confirm.</p>
                  </aside>
                </div>
              </>}
              <section className="ledger" aria-labelledby="ledger-heading">
                <div className="ledger-heading"><div><p className="eyebrow">Your service book</p><h2 id="ledger-heading">My confirmed appointments <span className="count">{ledger.length}</span></h2></div><button className="secondary" onClick={() => void refreshLedger()}>Refresh appointments</button></div>
                {ledgerError && <div className="notice error" role="alert">{ledgerError}</div>}
                {!ledger.length ? <div className="empty-state"><Mark /><h3>A clear road ahead</h3><p>Your confirmed appointments will appear here.</p></div>
                  : <div className="appointment-list">{ledger.map(appointment => <article className="appointment-row" data-testid="appointment" key={appointment.id}>
                    <div className="date-tile" aria-hidden="true"><strong>{new Intl.DateTimeFormat('en', { day: '2-digit', timeZone: appointment.timezone }).format(appointment.startMs)}</strong><span>{new Intl.DateTimeFormat('en', { month: 'short', timeZone: appointment.timezone }).format(appointment.startMs)}</span></div>
                    <div className="appointment-main">
                      <h3><span className="field-label">Service:</span> {appointment.serviceName}</h3>
                      <dl className="record-fields">
                        <div><dt>Customer:</dt><dd>{appointment.customerName}</dd></div>
                        <div><dt>Vehicle:</dt><dd>{appointment.vehicleLabel}</dd></div>
                        <div><dt>Vehicle ID:</dt><dd>{appointment.vehicleId}</dd></div>
                        <div><dt>Appointment ID:</dt><dd className="reference">{appointment.id}</dd></div>
                      </dl>
                    </div>
                    <div className="appointment-time">
                      <dl className="record-fields">
                        <div><dt>Date:</dt><dd>{formatDate(appointment.startMs, appointment.timezone)}</dd></div>
                        <div><dt>Time:</dt><dd>{formatTime(appointment.startMs, appointment.timezone)}-{formatTime(appointment.endMs, appointment.timezone)}</dd></div>
                        <div><dt>Timezone:</dt><dd>{formatUtcOffset(appointment.startMs, appointment.timezone)}</dd></div>
                        <div><dt>Dealership:</dt><dd>{appointment.dealershipName}</dd></div>
                      </dl>
                    </div>
                    <div className="appointment-resource">
                      <span className="confirmed-tag">Status: Confirmed</span>
                      <dl className="record-fields">
                        <div><dt>Technician:</dt><dd>{appointment.technicianName}</dd></div>
                        <div><dt>Service bay:</dt><dd>{appointment.bayName}</dd></div>
                        <div><dt>Duration:</dt><dd>{appointment.durationMinutes} minutes</dd></div>
                      </dl>
                    </div>
                  </article>)}</div>}
              </section>
            </>}
    </main>
    <footer><span>service studio</span><p>Real bookings. Thoughtfully coordinated.</p><span>Local demonstration · Fictional customer data</span></footer>
  </>;
}
