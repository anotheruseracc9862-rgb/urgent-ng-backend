import { ApiExtraModels } from '@nestjs/swagger';

/**
 * A response whose fields are documented by the area's own description rather than a class (an
 * explanation, a nested case file). The envelope is still documented; the body is an object.
 */
@ApiExtraModels()
export class AnyObjectDto {
  [key: string]: unknown;
}
