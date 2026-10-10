import { describe, expect, it } from 'vitest';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { AssignmentService } from './assignment.service.js';

describe('AssignmentService', () => {
  it('selects a valid active offer as a pending acceptance assignment', () => {
    const service = new AssignmentService();

    const assignment = service.selectRunner({
      errandId: 'errand-1',
      requesterId: 'requester-1',
      runnerId: 'runner-1',
      offer: {
        id: 'offer-1',
        errandId: 'errand-1',
        runnerId: 'runner-1',
        requesterId: 'requester-1',
        status: 'ACTIVE',
        awaitingParty: 'REQUESTER',
        version: 3,
        amountMinor: 25000,
      },
      deadlineAt: new Date('2024-01-16T12:00:00.000Z'),
    });

    expect(assignment.status).toBe('PENDING_ACCEPTANCE');
    expect(service.getForErrand('errand-1')?.offerId).toBe('offer-1');
  });

  it('refuses a second assignment for the same errand while the first is still active', () => {
    const service = new AssignmentService();

    service.selectRunner({
      errandId: 'errand-2',
      requesterId: 'requester-2',
      runnerId: 'runner-2',
      offer: {
        id: 'offer-2',
        errandId: 'errand-2',
        runnerId: 'runner-2',
        requesterId: 'requester-2',
        status: 'ACTIVE',
        awaitingParty: 'REQUESTER',
        version: 2,
        amountMinor: 20000,
      },
      deadlineAt: new Date('2024-01-16T13:00:00.000Z'),
    });

    expect(() =>
      service.selectRunner({
        errandId: 'errand-2',
        requesterId: 'requester-2',
        runnerId: 'runner-3',
        offer: {
          id: 'offer-3',
          errandId: 'errand-2',
          runnerId: 'runner-3',
          requesterId: 'requester-2',
          status: 'ACTIVE',
          awaitingParty: 'REQUESTER',
          version: 1,
          amountMinor: 22000,
        },
        deadlineAt: new Date('2024-01-16T13:30:00.000Z'),
      }),
    ).toThrow(DomainException);
  });

  it('moves a selected runner through accept and timeout flows on separate assignments', () => {
    const service = new AssignmentService();

    const acceptedAssignment = service.selectRunner({
      errandId: 'errand-3',
      requesterId: 'requester-3',
      runnerId: 'runner-4',
      offer: {
        id: 'offer-4',
        errandId: 'errand-3',
        runnerId: 'runner-4',
        requesterId: 'requester-3',
        status: 'ACTIVE',
        awaitingParty: 'REQUESTER',
        version: 1,
        amountMinor: 15000,
      },
      deadlineAt: new Date('2024-01-16T12:30:00.000Z'),
    });

    expect(service.acceptAssignment(acceptedAssignment.id).status).toBe('ACCEPTED');

    const timedOutAssignment = service.selectRunner({
      errandId: 'errand-4',
      requesterId: 'requester-4',
      runnerId: 'runner-5',
      offer: {
        id: 'offer-5',
        errandId: 'errand-4',
        runnerId: 'runner-5',
        requesterId: 'requester-4',
        status: 'ACTIVE',
        awaitingParty: 'REQUESTER',
        version: 2,
        amountMinor: 18000,
      },
      deadlineAt: new Date('2024-01-16T12:45:00.000Z'),
    });

    expect(service.timeoutAssignment(timedOutAssignment.id).status).toBe('TIMED_OUT');
  });
});
