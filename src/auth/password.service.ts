import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ARGON_OPTIONS } from './argon.js';


/**
 * Argon2id hashing (Backend PRD 9.3). `verify` always does the same amount of work,
 * even when there is no account, so a response time cannot reveal which phone
 * numbers or emails are registered.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash('urgent-ng-dummy-password', ARGON_OPTIONS);
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON_OPTIONS);
  }

  /** `hash` is null when the account does not exist: a dummy check keeps timing equal. */
  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!this.dummyHash) {
      this.dummyHash = await argon2.hash('urgent-ng-dummy-password', ARGON_OPTIONS);
    }
    try {
      const valid = await argon2.verify(hash ?? this.dummyHash, password);
      return hash ? valid : false;
    } catch {
      return false;
    }
  }
}
