import { ApiProperty } from '@nestjs/swagger';

export class EventTicketDto {
  @ApiProperty({ description: 'Pass as `?ticket=` to GET /events. Valid once, for 60 seconds.' })
  ticket!: string;

  @ApiProperty()
  expiresInSeconds!: number;
}
