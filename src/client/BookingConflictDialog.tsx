import { useEffect, useRef } from 'react';

const explanations: Record<string, { title: string; message: string }> = {
  BAY_BUSY: {
    title: 'That time is no longer available',
    message: 'A service bay is no longer free for your entire appointment.',
  },
  TECHNICIAN_BUSY: {
    title: 'That time is no longer available',
    message: 'A qualified technician is no longer free for your entire appointment.',
  },
  VEHICLE_BUSY: {
    title: 'Your vehicle already has a booking',
    message: 'This vehicle has an overlapping appointment, so we could not add this one.',
  },
  OUTSIDE_TECHNICIAN_SHIFT: {
    title: 'That time no longer fits the schedule',
    message: 'A qualified technician’s shift must cover the whole service, including any breaks.',
  },
  OUTSIDE_OPENING_HOURS: {
    title: 'That time no longer fits the schedule',
    message: 'The whole service must fit within the dealership’s opening hours.',
  },
  NO_QUALIFIED_TECHNICIAN: {
    title: 'We couldn’t find the right technician',
    message: 'There is no technician with the qualifications needed for this service.',
  },
  PAST_START: {
    title: 'That start time has passed',
    message: 'Please choose a future start time for your appointment.',
  },
};

export function getConflictExplanation(code: string) {
  return Object.hasOwn(explanations, code) ? explanations[code] : undefined;
}

export type BookingConflict = {
  title: string;
  message: string;
  service: string;
  dealership: string;
  localStart: string;
  timezone: string;
};

export function BookingConflictDialog({ conflict, onDismiss }: {
  conflict: BookingConflict;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    titleRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  return <dialog ref={ref} className="booking-conflict-dialog" role="alertdialog"
    aria-modal="true" aria-labelledby="booking-conflict-title" aria-describedby="booking-conflict-description"
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      if (!event.shiftKey && event.target === actionRef.current) {
        event.preventDefault();
        closeRef.current?.focus();
      } else if (event.shiftKey && event.target === closeRef.current) {
        event.preventDefault();
        actionRef.current?.focus();
      }
    }}
    onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <button ref={closeRef} className="dialog-close" type="button" aria-label="Close booking notice" onClick={onDismiss}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
    <div className="conflict-symbol" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3v1" /></svg>
    </div>
    <h2 ref={titleRef} id="booking-conflict-title" tabIndex={-1}>{conflict.title}</h2>
    <div id="booking-conflict-description">
      <p>{conflict.message}</p>
      <p><strong>No appointment was created.</strong></p>
    </div>
    <div className="conflict-appointment">
      <strong>{conflict.service}</strong>
      <p>{conflict.dealership}</p>
      <p>{conflict.localStart.replace('T', ' at ')} · {conflict.timezone}</p>
    </div>
    <p className="conflict-help">Selecting a time doesn’t reserve it. Availability is checked again when you confirm.</p>
    <button ref={actionRef} className="primary" type="button" onClick={onDismiss}>Choose another time</button>
  </dialog>;
}
