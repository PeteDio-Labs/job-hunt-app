import { describe, expect, it } from 'bun:test';
import {
  APPLICATION_STATUSES,
  InvalidTransitionError,
  assertTransition,
  canTransition,
} from '../src/domain/status-machine.ts';

describe('status-machine', () => {
  it('allows the happy-path flow', () => {
    expect(canTransition('drafting', 'pending_review')).toBe(true);
    expect(canTransition('pending_review', 'submitted')).toBe(true);
    expect(canTransition('submitted', 'responded')).toBe(true);
    expect(canTransition('responded', 'offer')).toBe(true);
  });

  it('allows withdraw from any non-terminal state', () => {
    expect(canTransition('drafting', 'withdrawn')).toBe(true);
    expect(canTransition('pending_review', 'withdrawn')).toBe(true);
    expect(canTransition('submitted', 'withdrawn')).toBe(true);
    expect(canTransition('responded', 'withdrawn')).toBe(true);
    expect(canTransition('offer', 'withdrawn')).toBe(true);
  });

  it('lets pending_review go back to drafting', () => {
    expect(canTransition('pending_review', 'drafting')).toBe(true);
  });

  it('forbids skipping pending_review', () => {
    expect(canTransition('drafting', 'submitted')).toBe(false);
  });

  it('forbids resurrecting terminal states', () => {
    expect(canTransition('rejected', 'drafting')).toBe(false);
    expect(canTransition('rejected', 'submitted')).toBe(false);
    expect(canTransition('withdrawn', 'drafting')).toBe(false);
  });

  it('forbids self-transitions', () => {
    for (const s of APPLICATION_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('assertTransition throws InvalidTransitionError on illegal moves', () => {
    expect(() => assertTransition('drafting', 'submitted')).toThrow(InvalidTransitionError);
  });

  it('assertTransition is silent on legal moves', () => {
    expect(() => assertTransition('drafting', 'pending_review')).not.toThrow();
  });
});
