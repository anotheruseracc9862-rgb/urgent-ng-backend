import { describe, expect, it } from 'vitest';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_INVALID_STATE, ERRAND_EXPIRED } from '../common/constants/error-codes.js';
import { mapSelectionError } from './assignment.service.js';

const invalid = (from: string) => DomainException.of(ERRAND_INVALID_STATE, { details: { from, to: 'RUNNER_SELECTED' } });

describe('mapSelectionError', () => {
  it.each(['RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED'])('turns a select on a %s errand into ASSIGNMENT_CONFLICT', (from) => {
    const mapped = mapSelectionError(invalid(from)) as DomainException;
    expect(mapped.getCode()).toBe('ASSIGNMENT_CONFLICT');
  });

  it.each(['CANCELLED', 'EXPIRED', 'DRAFT'])('keeps ERRAND_INVALID_STATE for a %s errand', (from) => {
    const error = invalid(from);
    expect(mapSelectionError(error)).toBe(error);
  });

  it('passes other errors through untouched', () => {
    const error = DomainException.of(ERRAND_EXPIRED);
    expect(mapSelectionError(error)).toBe(error);
    expect(mapSelectionError(new Error('boom'))).toBeInstanceOf(Error);
  });
});
