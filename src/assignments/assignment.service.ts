import { Injectable } from '@nestjs/common';
import { generateUuidV7 } from '../common/utils/uuid.helper.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  ASSIGNMENT_CONFLICT,
  ASSIGNMENT_INVALID_STATE,
  OFFER_INVALID_STATE,
  OFFER_VERSION_MISMATCH,
  RESOURCE_NOT_FOUND,
} from '../common/constants/error-codes.js';

export type AssignmentStatus = 'PENDING_ACCEPTANCE' | 'ACCEPTED' | 'DECLINED' | 'TIMED_OUT' | 'CANCELLED' | 'COMPLETED';

export interface AssignmentOfferSnapshot {
  id: string;
  errandId: string;
  runnerId: string;
  requesterId: string;
  status: 'ACTIVE' | 'WITHDRAWN' | 'REJECTED' | 'SELECTED' | 'EXPIRED' | 'CLOSED';
  awaitingParty: 'RUNNER' | 'REQUESTER' | 'NONE';
  version: number;
  amountMinor: number;
}

export interface AssignmentSelectionInput {
  errandId: string;
  requesterId: string;
  runnerId: string;
  offer: AssignmentOfferSnapshot;
  expectedOfferVersion?: number;
  deadlineAt: Date;
}

export interface AssignmentRecord {
  id: string;
  errandId: string;
  offerId: string;
  runnerId: string;
  requesterId: string;
  amountMinor: number;
  status: AssignmentStatus;
  deadlineAt: Date;
  selectedAt: Date;
  updatedAt: Date;
}

@Injectable()
export class AssignmentService {
  private readonly assignments = new Map<string, AssignmentRecord>();
  private readonly assignmentsByErrand = new Map<string, AssignmentRecord>();

  selectRunner(input: AssignmentSelectionInput): AssignmentRecord {
    const { errandId, requesterId, runnerId, offer, expectedOfferVersion, deadlineAt } = input;

    if (expectedOfferVersion !== undefined && offer.version !== expectedOfferVersion) {
      throw DomainException.of(OFFER_VERSION_MISMATCH, {
        message: 'The offer version no longer matches the selected offer.',
        details: { errandId, offerId: offer.id, expectedOfferVersion, actualVersion: offer.version },
      });
    }

    if (offer.errandId !== errandId) {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
        message: 'The selected offer does not belong to this errand.',
        details: { errandId, offerId: offer.id },
      });
    }

    if (offer.runnerId !== runnerId) {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
        message: 'The selected offer does not belong to the runner being assigned.',
        details: { errandId, runnerId, offerId: offer.id },
      });
    }

    if (offer.requesterId !== requesterId) {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
        message: 'The selected offer requester does not match the errand requester.',
        details: { errandId, requesterId, offerId: offer.id },
      });
    }

    if (offer.status !== 'ACTIVE') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: 'Only an active offer can be selected.',
        details: { offerId: offer.id, status: offer.status },
      });
    }

    if (offer.awaitingParty !== 'REQUESTER') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: 'The requester must be the party awaiting action before selecting an offer.',
        details: { offerId: offer.id, awaitingParty: offer.awaitingParty },
      });
    }

    if (this.assignmentsByErrand.has(errandId)) {
      throw DomainException.of(ASSIGNMENT_CONFLICT, {
        message: 'This errand already has an assignment in progress.',
        details: { errandId },
      });
    }

    const assignment: AssignmentRecord = {
      id: generateUuidV7(),
      errandId,
      offerId: offer.id,
      runnerId,
      requesterId,
      amountMinor: offer.amountMinor,
      status: 'PENDING_ACCEPTANCE',
      deadlineAt,
      selectedAt: new Date(),
      updatedAt: new Date(),
    };

    this.assignments.set(assignment.id, assignment);
    this.assignmentsByErrand.set(errandId, assignment);
    return assignment;
  }

  getById(assignmentId: string): AssignmentRecord | undefined {
    return this.assignments.get(assignmentId);
  }

  getForErrand(errandId: string): AssignmentRecord | undefined {
    return this.assignmentsByErrand.get(errandId);
  }

  acceptAssignment(assignmentId: string): AssignmentRecord {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Assignment not found.' });
    }

    if (assignment.status !== 'PENDING_ACCEPTANCE') {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
        message: 'Only a pending assignment can be accepted.',
        details: { assignmentId, status: assignment.status },
      });
    }

    assignment.status = 'ACCEPTED';
    assignment.updatedAt = new Date();
    return assignment;
  }

  declineAssignment(assignmentId: string): AssignmentRecord {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Assignment not found.' });
    }

    if (assignment.status !== 'PENDING_ACCEPTANCE') {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
        message: 'Only a pending assignment can be declined.',
        details: { assignmentId, status: assignment.status },
      });
    }

    assignment.status = 'DECLINED';
    assignment.updatedAt = new Date();
    return assignment;
  }

  timeoutAssignment(assignmentId: string): AssignmentRecord {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Assignment not found.' });
    }

    if (assignment.status !== 'PENDING_ACCEPTANCE') {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
        message: 'Only a pending assignment can time out.',
        details: { assignmentId, status: assignment.status },
      });
    }

    assignment.status = 'TIMED_OUT';
    assignment.updatedAt = new Date();
    return assignment;
  }
}
