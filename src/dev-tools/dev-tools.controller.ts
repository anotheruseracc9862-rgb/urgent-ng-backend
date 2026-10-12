import { Controller, Get, NotFoundException, Query, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { NoEnvelope } from '../common/decorators/no-envelope.decorator.js';
import { OTP_PROVIDER } from '../common/providers/otp.provider.js';
import { FakeOtpProvider } from '../common/providers/fakes/otp.fake.js';

/**
 * A development helper for tests that run on the fake SMS provider (end-to-end suites):
 * `GET /dev/last-otp?destination=` returns the one-time code the fake provider "sent".
 *
 * The module is not imported in production, and the route answers 404 unless the provider behind
 * it is the fake one. Not part of the API contract (excluded from OpenAPI).
 */
@ApiExcludeController()
@Controller('dev')
export class DevToolsController {
  constructor(@Inject(OTP_PROVIDER) private readonly otp: unknown) {}

  @Get('last-otp')
  @NoEnvelope()
  lastOtp(@Query('destination') destination?: string): { destination: string; code: string } {
    if (!(this.otp instanceof FakeOtpProvider) || !destination) throw new NotFoundException();
    const last = this.otp
      .getCalls()
      .filter((call) => call.args[0] === destination)
      .at(-1);
    if (!last) throw new NotFoundException();
    return { destination, code: String(last.args[1]) };
  }
}
