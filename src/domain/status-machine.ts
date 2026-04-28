export const APPLICATION_STATUSES = [
  'drafting',
  'pending_review',
  'submitted',
  'responded',
  'rejected',
  'offer',
  'withdrawn',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

const TRANSITIONS: Readonly<Record<ApplicationStatus, ReadonlyArray<ApplicationStatus>>> = {
  drafting:      ['pending_review', 'withdrawn'],
  pending_review:['submitted', 'drafting', 'withdrawn'],
  submitted:     ['responded', 'rejected', 'withdrawn'],
  responded:     ['offer', 'rejected', 'withdrawn'],
  rejected:      [],
  offer:         ['rejected', 'withdrawn'],
  withdrawn:     [],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ApplicationStatus,
    public readonly to: ApplicationStatus,
  ) {
    super(`Illegal status transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}
