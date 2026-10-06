import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { BlocklistService } from './blocklist.service.js';
import { OtpService, OtpPurpose } from './otp.service.js';
import { RegisterDto, ConsentDto } from './dto/register.dto.js';
import * as argon2 from 'argon2';

/**
 * Registration Service (P2-02)
 * Per PRD §9.2:
 * - Register with name, phone OR email, password
 * - Required policy consents with versions
 * - Blocklist check prevents registration
 * - Passwords hashed with Argon2id
 * - OTP verification required before user can post errands or submit offers
 */

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blocklistService: BlocklistService,
    private readonly otpService: OtpService,
  ) {}

  /**
   * Register a new user
   * Returns userId and sends OTP to the provided phone/email
   */
  async register(dto: RegisterDto, ipAddress?: string): Promise<{ userId: string; otpSent: boolean }> {
    // Validate that at least one identifier is provided
    const validationError = RegisterDto.validate(dto);
    if (validationError) {
      throw new BadRequestException(validationError);
    }

    // Blocklist check
    if (dto.phone) {
      const isBlocked = await this.blocklistService.isPhoneBlocked(dto.phone);
      if (isBlocked) {
        this.logger.warn({
          message: 'Registration blocked - phone on blocklist',
          phone: this.maskIdentifier(dto.phone),
          ipAddress,
        });
        throw new BadRequestException('REGISTRATION_BLOCKED');
      }
    }

    if (dto.email) {
      const isBlocked = await this.blocklistService.isEmailBlocked(dto.email);
      if (isBlocked) {
        this.logger.warn({
          message: 'Registration blocked - email on blocklist',
          email: this.maskIdentifier(dto.email),
          ipAddress,
        });
        throw new BadRequestException('REGISTRATION_BLOCKED');
      }
    }

    // Check for existing user with same phone or email
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          dto.phone ? { phoneE164: dto.phone } : {},
          dto.email ? { email: dto.email } : {},
        ],
        deletedAt: null,
      },
    });

    if (existingUser) {
      if (existingUser.phoneE164 === dto.phone) {
        throw new ConflictException('PHONE_ALREADY_REGISTERED');
      }
      if (existingUser.email === dto.email) {
        throw new ConflictException('EMAIL_ALREADY_REGISTERED');
      }
    }

    // Hash password with Argon2id
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,
      parallelism: 4,
    });

    // Verify required policy versions exist
    const requiredPolicyTypes = ['TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'SAFETY_POLICY', 'PROHIBITED_ITEMS_POLICY'];
    const missingPolicies = requiredPolicyTypes.filter(
      (type) => !dto.consents.find((c: ConsentDto) => c.type === type),
    );

    if (missingPolicies.length > 0) {
      throw new BadRequestException({
        error: 'MISSING_REQUIRED_CONSENTS',
        missingPolicies,
      });
    }

    // Verify policy versions exist in database
    const policyVersions = await this.prisma.policyVersion.findMany({
      where: {
        type: { in: dto.consents.map((c: ConsentDto) => c.type) as any },
        version: { in: dto.consents.map((c: ConsentDto) => c.version) },
      },
    });

    if (policyVersions.length !== dto.consents.length) {
      throw new BadRequestException('INVALID_POLICY_VERSION');
    }

    // Create user, profile, and consent records in a transaction
    const result = await this.prisma.$transaction(async (tx: any) => {
      // Split name into first and last name (simple split on space)
      const nameParts = dto.name.trim().split(' ');
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || firstName;

      // Create user
      const user = await tx.user.create({
        data: {
          name: dto.name,
          firstName,
          lastName,
          phoneE164: dto.phone || null,
          email: dto.email || null,
          passwordHash,
          status: 'ACTIVE',
          phoneVerifiedAt: null,
          emailVerifiedAt: null,
        },
      });

      // Create profile
      await tx.profile.create({
        data: {
          userId: user.id,
          photoMediaId: null,
          homePoint: null,
          homeArea: null,
        },
      });

      // Create consent records
      await tx.consentRecord.createMany({
        data: dto.consents.map((consent: ConsentDto) => ({
          userId: user.id,
          consentType: consent.type,
          documentVersion: consent.version,
          ipAddress: ipAddress || null,
        })),
      });

      return user;
    });

    this.logger.log({
      message: 'User registered',
      userId: result.id,
      phone: dto.phone ? this.maskIdentifier(dto.phone) : undefined,
      email: dto.email ? this.maskIdentifier(dto.email) : undefined,
    });

    // Send OTP for verification
    const identifier = dto.phone || dto.email!;
    const otpResult = await this.otpService.sendOtp(
      identifier,
      OtpPurpose.REGISTRATION,
      ipAddress,
    );

    if (!otpResult.success) {
      this.logger.warn({
        message: 'Failed to send OTP after registration',
        userId: result.id,
        error: otpResult.error,
      });
    }

    return {
      userId: result.id,
      otpSent: otpResult.success,
    };
  }

  /**
   * Verify registration OTP and mark identifier as verified
   * This should be called after registration to verify the user's phone or email
   */
  async verifyRegistrationOtp(
    userId: string,
    identifier: string,
    code: string,
  ): Promise<{ success: boolean; error?: string }> {
    const verifyResult = await this.otpService.verifyOtp(
      identifier,
      code,
      OtpPurpose.REGISTRATION,
    );

    if (!verifyResult.success) {
      return verifyResult;
    }

    // Update user's verification status
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return { success: false, error: 'USER_NOT_FOUND' };
    }

    // Determine if identifier is phone or email
    const isPhone = identifier.startsWith('+');
    const isEmail = identifier.includes('@');

    if (isPhone && user.phoneE164 === identifier) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { phoneVerifiedAt: new Date() },
      });
    } else if (isEmail && user.email === identifier) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date() },
      });
    } else {
      return { success: false, error: 'IDENTIFIER_MISMATCH' };
    }

    this.logger.log({
      message: 'Identifier verified',
      userId,
      identifier: this.maskIdentifier(identifier),
    });

    return { success: true };
  }

  /**
   * Verify identifier for existing user (phone/email verification after registration)
   * Finds the user by identifier and marks it as verified
   */
  async verifyIdentifierByLookup(
    identifier: string,
    code: string,
    purpose: OtpPurpose,
  ): Promise<{ success: boolean; userId?: string; error?: string }> {
    // Verify the OTP first
    const verifyResult = await this.otpService.verifyOtp(identifier, code, purpose);

    if (!verifyResult.success) {
      return { success: false, error: verifyResult.error };
    }

    // Find user by identifier
    const isPhone = identifier.startsWith('+');
    const user = await this.prisma.user.findFirst({
      where: isPhone
        ? { phoneE164: identifier, deletedAt: null }
        : { email: identifier, deletedAt: null },
    });

    if (!user) {
      return { success: false, error: 'USER_NOT_FOUND' };
    }

    // Mark as verified
    if (isPhone) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { phoneVerifiedAt: new Date() },
      });
    } else {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
    }

    this.logger.log({
      message: 'Identifier verified via lookup',
      userId: user.id,
      identifier: this.maskIdentifier(identifier),
      purpose,
    });

    return { success: true, userId: user.id };
  }

  /**
   * Mask identifier for logging (show first 2 and last 2 characters)
   */
  private maskIdentifier(identifier: string): string {
    if (identifier.length <= 4) return '****';
    return identifier.slice(0, 2) + '****' + identifier.slice(-2);
  }
}
