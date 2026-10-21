import { useEffect, useState } from 'react';
import { slotWindowSchema, type SlotWindow, type TimeSlot } from '../shared/contracts.js';
import { requestApi, ApiError } from './api.js';

function formatCalendarDate(date: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

export function TimePicker({ customerId, vehicleId, dealershipId, serviceId, duration, preferredDate, selectedStart, locked, refreshKey, onSelect }: {
  customerId: string;
  vehicleId: string;
  dealershipId: string;
  serviceId: string;
  duration: number;
  preferredDate: string | null;
  selectedStart: string;
  locked: boolean;
  refreshKey: number;
  onSelect: (slot: TimeSlot | null) => void;
}) {
  const [startDate, setStartDate] = useState<string>();
  const [selectedDate, setSelectedDate] = useState(preferredDate ?? '');
  const [window, setWindow] = useState<SlotWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expiredWindow, setExpiredWindow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setExpiredWindow(false);
    setWindow(null);
    requestApi('availability/slots', slotWindowSchema, { vehicleId, dealershipId, serviceId, startDate }, customerId)
      .then(result => {
        if (!active) return;
        setWindow(result);
        setSelectedDate(current => result.days.some(day => day.date === current) ? current : result.startDate);
      })
      .catch(error => {
        if (!active) return;
        setExpiredWindow(error instanceof ApiError && error.code === 'DATE_IN_PAST');
        setError(error instanceof Error ? error.message : 'Could not load available times.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [customerId, vehicleId, dealershipId, serviceId, startDate, refreshKey, attempt]);

  const day = window?.days.find(day => day.date === selectedDate);
  const available = day?.slots.filter(slot => slot.available) ?? [];
  const unavailable = day?.slots.filter(slot => !slot.available) ?? [];
  function changeWeek(date: string | null | undefined) {
    if (!date || locked) return;
    onSelect(null);
    setSelectedDate(date);
    setStartDate(date);
    setLoading(true);
    setWindow(null);
  }

  return <section className="time-picker" aria-labelledby="time-picker-heading">
    <div className="section-title"><span className="step-number">02</span><div>
      <h2 id="time-picker-heading" tabIndex={-1}>Find a time that fits</h2>
      <p>Start times every 15 minutes. We reserve the full {duration}-minute service.</p>
    </div></div>
    <div className="week-toolbar">
      <div><strong>{window ? `${formatCalendarDate(window.startDate, { day: 'numeric', month: 'short' })} - ${formatCalendarDate(window.endDate, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Next seven days'}</strong>
        <p>{window?.timezone ?? 'Dealership-local times'}</p></div>
      <div className="week-actions">
        <button className="secondary" type="button" aria-label="Previous 7 days" disabled={locked || loading || !window?.previousStartDate} onClick={() => changeWeek(window?.previousStartDate)}>Previous</button>
        <button className="secondary" type="button" aria-label="Next 7 days" disabled={locked || loading || !window?.nextStartDate} onClick={() => changeWeek(window?.nextStartDate)}>Next</button>
      </div>
    </div>
    {loading ? <div className="slot-loading" role="status">Loading available times...</div> : error
      ? <div className="notice error" role="alert">Could not load times. {error}</div> : window && <>
        <div className="date-strip" role="group" aria-label="Choose an appointment day">
          {window.days.map(date => {
            const count = date.slots.filter(slot => slot.available).length;
            return <button key={date.date} data-testid={`day-${date.date}`} type="button" className={`day-button${selectedDate === date.date ? ' selected' : ''}`}
              aria-pressed={selectedDate === date.date}
              aria-label={`${formatCalendarDate(date.date, { weekday: 'long', day: 'numeric', month: 'long' })}, ${date.closed ? 'closed' : `${count} available times`}`}
              disabled={locked} onClick={() => { onSelect(null); setSelectedDate(date.date); }}>
              <span>{formatCalendarDate(date.date, { weekday: 'short' })}</span>
              <strong>{formatCalendarDate(date.date, { day: 'numeric' })}</strong>
              <span className="day-count">{date.closed ? 'Closed' : count ? `${count} times` : 'No times'}</span>
            </button>;
          })}
        </div>
        <p className="date-strip-hint">Scroll the dates to see all seven days.</p>
        <div className="day-slots" aria-busy={loading}>
          <h3>{formatCalendarDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
          <p className="slot-guidance" role="status">{day?.closed ? 'The dealership is closed on this day.' : available.length
            ? `${available.length} available start times. Pick one to continue.`
            : 'No available start times on this day. Try another day or the next seven days.'}</p>
          {['Morning', 'Afternoon'].map(period => {
            const slots = available.filter(slot => period === 'Morning' ? slot.time < '12:00' : slot.time >= '12:00');
            return slots.length > 0 && <fieldset key={period} className="time-group" disabled={locked}>
              <legend>{period}</legend>
              <div className="time-buttons">{slots.map(slot => <button key={slot.localStart} type="button"
                className={`time-button${selectedStart === slot.localStart ? ' selected' : ''}`}
                aria-pressed={selectedStart === slot.localStart} aria-label={`Start at ${slot.time}`}
                onClick={() => onSelect(slot)}>{slot.time}</button>)}</div>
            </fieldset>;
          })}
          {unavailable.length > 0 && <details className="unavailable-times" key={selectedDate}>
            <summary>Unavailable times ({unavailable.length})</summary>
            <p>These starts cannot accommodate the whole service. They cannot be selected.</p>
            <ul>{unavailable.map(slot => <li data-testid="unavailable-slot" key={slot.localStart}><time>{slot.time}</time><span>{slot.message}</span></li>)}</ul>
          </details>}
        </div>
      </>}
    <button className="secondary refresh-times" type="button" disabled={locked || loading} onClick={() => {
      onSelect(null);
      if (expiredWindow) { setStartDate(undefined); setSelectedDate(''); }
      setAttempt(value => value + 1);
    }}>Refresh times</button>
    <p className="slot-footnote">Times are a live preview, not a hold. Availability is checked again when you confirm.</p>
  </section>;
}
