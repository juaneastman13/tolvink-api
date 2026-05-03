import { Injectable } from '@nestjs/common';
import { FreightLocationsService } from '../../freight-locations/freight-locations.service';

type AllowedPublicType = 'ORIGIN' | 'DESTINATION' | 'POINT_OF_INTEREST';

@Injectable()
export class AgentV2LocationTools {
  constructor(private freightLocations: FreightLocationsService) {}

  /**
   * Emit a public (no-auth) map link for a freight, restricted to the given location types.
   * Returned URL is meant to be sent to the user via WhatsApp so anyone with the link can pin
   * one or more origin/destination/POI locations until the link expires.
   */
  async generatePublicMapLink(
    freightId: string,
    opts: {
      allowedTypes?: AllowedPublicType[];
      ttlMinutes?: number;
      purpose?: string;
      createdByUserId?: string;
    } = {},
  ): Promise<{ url: string; ttlMinutes: number; allowedTypes: string[]; jti: string }> {
    const result = await this.freightLocations.createPublicMapLink(freightId, {
      allowedTypes: opts.allowedTypes,
      ttlMinutes: opts.ttlMinutes,
      purpose: opts.purpose || 'agent_v2',
      createdByUserId: opts.createdByUserId,
    });
    return {
      url: result.url,
      ttlMinutes: result.expiresInMinutes,
      allowedTypes: result.allowedTypes,
      jti: result.jti,
    };
  }
}
