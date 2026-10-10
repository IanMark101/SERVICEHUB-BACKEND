type TrustEvent = {
  id: string; delta: number; reason: string; scoreBefore: number; scoreAfter: number;
  createdAt: Date; eventKey: string | null;
};

function publicReason(event: TrustEvent): string {
  const key = event.eventKey || '';
  if (key.startsWith('account-baseline:') || event.reason === 'Initial Account Base Trust Score Baseline') return 'Account created: starting trust score';
  if (key.startsWith('verification-approval:')) return 'Residency and identity verified';
  if (key.startsWith('booking-completion:')) return 'Service completed and confirmed';
  if (key.startsWith('review:')) {
    const rating = /^Received ([1-5])-star (provider|seeker) review$/.exec(event.reason);
    if (rating) return `Received a ${rating[1]}-star ${rating[2]} review`;
    if (/^Review rating updated from [1-5] to [1-5]$/.test(event.reason)) return event.reason;
    if (event.reason === 'Review hidden by administrator') return 'Review removed from trust calculation';
    if (event.reason === 'Review restored by administrator') return 'Review restored to trust calculation';
    return 'Review contribution adjusted';
  }
  if (key.startsWith('cancellation:')) return 'At-fault booking cancellation';
  if (key.startsWith('report:')) return 'Violation confirmed by administrator';
  if (key.startsWith('manual-trust:')) return 'Trust score adjusted by administrator';
  // Legacy and new event types remain visible without publishing free-text notes.
  return 'Trust score adjustment';
}

export function toPublicTrustEvent(event: TrustEvent) {
  return {
    id: event.id, delta: event.delta, reason: publicReason(event),
    scoreBefore: event.scoreBefore, scoreAfter: event.scoreAfter, createdAt: event.createdAt,
  };
}
