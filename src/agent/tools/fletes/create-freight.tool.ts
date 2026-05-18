import { Injectable, Logger } from '@nestjs/common';
import { FreightsService } from '../../../freights/freights.service';
import { CreateFreightDto } from '../../../freights/freights.dto';
import { UserContext } from '../context/user-context.service';
import { CreateFreightSlots } from '../../flows/create-freight/create-freight.types';

@Injectable()
export class CreateFreightTool {
  private readonly logger = new Logger(CreateFreightTool.name);

  constructor(private freightsService: FreightsService) {}

  /**
   * Execute freight creation with collected slots.
   */
  async execute(userCtx: UserContext, slots: CreateFreightSlots): Promise<{ code: string }> {
    if (!userCtx.userId || !userCtx.companyId) {
      throw new Error('Missing user context');
    }

    if (!slots.grain || !slots.tons || !slots.loadDate || !slots.loadTime) {
      throw new Error('Missing required slots');
    }

    // Build DTO
    const dto: CreateFreightDto = {
      loadDate: slots.loadDate,
      loadTime: slots.loadTime,
      items: [
        {
          grain: slots.grain,
          tons: slots.tons,
          unit: 'toneladas',
        },
      ],
    };

    // Origin: either fieldId or override lat/lng
    if (slots.originFieldId) {
      dto.fieldId = slots.originFieldId;
    } else if (slots.originLat !== undefined && slots.originLng !== undefined) {
      dto.overrideOriginLat = slots.originLat;
      dto.overrideOriginLng = slots.originLng;
      if (slots.originName) {
        dto.customOriginName = slots.originName;
      }
    } else {
      throw new Error('Origin not specified: need field ID or lat/lng');
    }

    // Destination: either tolvinkPlantId or customDestName
    if (slots.tolvinkPlantId) {
      dto.tolvinkPlantId = slots.tolvinkPlantId;
    } else if (slots.destName) {
      dto.customDestName = slots.destName;
    } else {
      throw new Error('Destination not specified');
    }

    // Build synthetic user (mimics JWT-like structure)
    const syntheticUser = {
      sub: userCtx.userId,
      companyId: userCtx.companyId,
      companyType: userCtx.companyType,
      role: 'operator',
      companyTypes: [userCtx.companyType],
    };

    this.logger.debug(`Creating freight with DTO: ${JSON.stringify(dto, null, 2)}`);

    try {
      const freight = await this.freightsService.create(dto, syntheticUser as any);
      this.logger.log(`Freight created: ${freight.code}`);
      return { code: freight.code };
    } catch (error) {
      this.logger.error(`Freight creation failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
