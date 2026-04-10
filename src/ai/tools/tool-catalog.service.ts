import { Injectable } from '@nestjs/common';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod/v3';
import { buildSyntheticUser } from '../../common/build-synthetic-user';
import { getCompanyTypes } from '../../common/company-type-helpers';
import { FreightsService } from '../../freights/freights.service';
import { AiToolDescriptor, AgentExecutionContext } from '../contracts/agent.types';
import { FreightReferenceService } from '../resolution/freight-reference.service';
import { LogisticsEntityReferenceService } from '../resolution/logistics-entity-reference.service';

@Injectable()
export class ToolCatalogService {
  private readonly descriptors: AiToolDescriptor[] = [
    {
      name: 'list_freights',
      description: 'List active or recent freights visible to the current user. Use for status or search queries.',
      domain: 'freights',
      tags: ['query'],
      allowedIntents: ['freight_query', 'freight_create', 'freight_update', 'unknown'],
      write: false,
      strongModelOnly: false,
      risk: 'low',
    },
    {
      name: 'get_freight_detail',
      description: 'Fetch full freight detail for a specific freight ID when the user asks about one freight.',
      domain: 'freights',
      tags: ['query'],
      allowedIntents: ['freight_query', 'freight_update', 'unknown'],
      requiredEntityKeys: ['freightRef'],
      write: false,
      strongModelOnly: false,
      risk: 'low',
    },
    {
      name: 'get_freight_stats',
      description: 'Get freight statistics and dashboard counters for the current company and user scope.',
      domain: 'freights',
      tags: ['query'],
      allowedIntents: ['freight_query', 'unknown'],
      write: false,
      strongModelOnly: false,
      risk: 'low',
    },
    {
      name: 'create_freight',
      description: 'Create a new freight after all required data is confirmed.',
      domain: 'freights',
      tags: ['create'],
      allowedIntents: ['freight_create'],
      requiredCompanyTypes: ['producer', 'plant'],
      write: true,
      strongModelOnly: true,
      risk: 'high',
    },
    {
      name: 'start_freight',
      description: 'Start an assigned freight when the trip is ready to begin.',
      domain: 'freights',
      tags: ['lifecycle'],
      allowedIntents: ['freight_update'],
      requiredEntityKeys: ['freightRef'],
      write: true,
      strongModelOnly: true,
      risk: 'high',
    },
    {
      name: 'confirm_loaded',
      description: 'Confirm that a freight was loaded and optionally record loaded tons.',
      domain: 'freights',
      tags: ['lifecycle'],
      allowedIntents: ['freight_update'],
      requiredEntityKeys: ['freightRef'],
      write: true,
      strongModelOnly: true,
      risk: 'high',
    },
    {
      name: 'confirm_finished',
      description: 'Confirm that a freight was delivered and finished.',
      domain: 'freights',
      tags: ['lifecycle'],
      allowedIntents: ['freight_update'],
      requiredEntityKeys: ['freightRef'],
      write: true,
      strongModelOnly: true,
      risk: 'high',
    },
    {
      name: 'cancel_freight',
      description: 'Cancel a freight and record the cancellation reason.',
      domain: 'freights',
      tags: ['lifecycle'],
      allowedIntents: ['freight_update'],
      requiredEntityKeys: ['freightRef'],
      write: true,
      strongModelOnly: true,
      risk: 'high',
    },
  ];

  constructor(
    private freights: FreightsService,
    private freightRef: FreightReferenceService,
    private logisticsRefs: LogisticsEntityReferenceService,
  ) {}

  listDescriptors(): AiToolDescriptor[] {
    return [...this.descriptors];
  }

  buildTools(context: AgentExecutionContext, allowedNames: string[]): DynamicStructuredTool[] {
    return this.descriptors
      .filter((descriptor) => allowedNames.includes(descriptor.name))
      .map((descriptor) => this.createTool(descriptor, context));
  }

  private createTool(descriptor: AiToolDescriptor, context: AgentExecutionContext): DynamicStructuredTool {
    switch (descriptor.name) {
      case 'list_freights':
        return tool(
          async (input) => {
            const result = await this.freights.findAll(this.buildAgentUser(context), {
              status: input.status || undefined,
              search: input.search || undefined,
              limit: Math.min(input.limit || 10, 20),
            });
            const rows = Array.isArray((result as any)?.data) ? (result as any).data : [];
            if (rows.length === 1) {
              await this.freightRef.remember(context, rows[0]);
            }
            return JSON.stringify(result);
          },
          {
            name: descriptor.name,
            description: descriptor.description,
            schema: z.object({
              status: z.string().optional(),
              search: z.string().optional(),
              limit: z.number().int().min(1).max(20).optional(),
            }),
          },
        );

      case 'get_freight_detail':
        return tool(
          async (input) => {
            const result = await this.freightRef.resolve(context, {
              freightRef: input.freightRef,
              freightId: input.freightId,
            });
            return JSON.stringify(result);
          },
          {
            name: descriptor.name,
            description: descriptor.description,
            schema: z.object({
              freightId: z.string().uuid().optional(),
              freightRef: z.string().min(1).max(100).optional(),
            }),
          },
        );

      case 'get_freight_stats':
        return tool(
          async (input) => {
            const result = await this.freights.getStats(
              this.buildAgentUser(context),
              input.from || undefined,
              input.to || undefined,
              input.groupBy || 'week',
            );
            return JSON.stringify(result);
          },
          {
            name: descriptor.name,
            description: descriptor.description,
            schema: z.object({
              from: z.string().optional(),
              to: z.string().optional(),
              groupBy: z.enum(['day', 'week', 'month']).optional(),
            }),
          },
        );

      case 'create_freight':
        return tool(
          async (input) => {
            const resolvedField = input.fieldId
              ? { id: input.fieldId }
              : input.fieldRef
                ? await this.logisticsRefs.resolveField(context, input.fieldRef)
                : undefined;
            const resolvedLot = input.originLotId
              ? { id: input.originLotId }
              : input.originLotRef
                ? await this.logisticsRefs.resolveLot(context, input.originLotRef, resolvedField?.id)
                : undefined;
            const resolvedPlant = input.destPlantId
              ? { id: input.destPlantId }
              : input.destPlantRef
                ? await this.logisticsRefs.resolvePlant(context, input.destPlantRef)
                : undefined;
            const resolvedTruck = input.truckId
              ? { id: input.truckId }
              : input.truckRef
                ? await this.logisticsRefs.resolveTruck(context, input.truckRef)
                : undefined;
            const resolvedDriver = input.driverId
              ? { id: input.driverId }
              : input.driverRef
                ? await this.logisticsRefs.resolveDriver(context, input.driverRef)
                : undefined;

            const result = await this.freights.create({
              fieldId: resolvedField?.id || undefined,
              originLotId: resolvedLot?.id || undefined,
              customOriginName: input.customOriginName || undefined,
              destPlantId: resolvedPlant?.id || undefined,
              destCompanyId: input.destCompanyId || undefined,
              customDestName: input.customDestName,
              loadDate: input.loadDate,
              loadTime: input.loadTime,
              notes: input.notes || undefined,
              truckCount: input.truckCount || undefined,
              items: input.items,
              useOwnFleet: input.useOwnFleet,
              truckId: resolvedTruck?.id || undefined,
              driverId: resolvedDriver?.id || undefined,
            }, this.buildAgentUser(context));
            await this.logisticsRefs.rememberResolved(context, {
              plant: resolvedPlant as any,
              field: resolvedField as any,
              lot: resolvedLot as any,
              truck: resolvedTruck as any,
              driver: resolvedDriver as any,
            });
            await this.freightRef.remember(context, result);
            return JSON.stringify(result);
          },
          {
            name: descriptor.name,
            description: descriptor.description,
            schema: z.object({
              fieldId: z.string().uuid().optional(),
              fieldRef: z.string().min(1).max(100).optional(),
              originLotId: z.string().uuid().optional(),
              originLotRef: z.string().min(1).max(100).optional(),
              customOriginName: z.string().min(1).max(255).optional(),
              destPlantId: z.string().uuid().optional(),
              destPlantRef: z.string().min(1).max(100).optional(),
              destCompanyId: z.string().uuid().optional(),
              customDestName: z.string().min(1).max(255),
              loadDate: z.string().min(10).max(10),
              loadTime: z.string().min(5).max(5),
              notes: z.string().max(1000).optional(),
              truckCount: z.number().int().min(1).max(50).optional(),
              useOwnFleet: z.boolean().optional(),
              truckId: z.string().uuid().optional(),
              truckRef: z.string().min(1).max(100).optional(),
              driverId: z.string().uuid().optional(),
              driverRef: z.string().min(1).max(100).optional(),
              items: z.array(z.object({
                grain: z.string().min(1).max(100),
                tons: z.number().positive().max(100000).optional(),
                unit: z.enum(['toneladas', 'kg', 'cantidad', 'metros', 'm3']).optional(),
                amount: z.number().nonnegative().optional(),
                productTypeOther: z.string().max(255).optional(),
                notes: z.string().max(1000).optional(),
              })).min(1).max(20),
            }),
          },
        );

      case 'start_freight':
        return tool(
          async (input) => {
            const freight = await this.freightRef.resolve(context, {
              freightRef: input.freightRef,
              freightId: input.freightId,
            });
            const result = await this.freights.start(freight.id, this.buildAgentUser(context), !!input.force);
            await this.freightRef.remember(context, { ...freight, ...result });
            return JSON.stringify(result);
          },
          {
            name: descriptor.name,
            description: descriptor.description,
            schema: z.object({
              freightId: z.string().uuid().optional(),
              freightRef: z.string().min(1).max(100).optional(),
              force: z.boolean().optional(),
            }),
          },
        );

      case 'confirm_loaded':
        return tool(
          async (input) => {
            const freight = await this.freightRef.resolve(context, {
              freightRef: input.freightRef,
              freightId: input.freightId,
            });
            const result = await this.freights.confirmLoaded(
              freight.id,
              this.buildAgentUser(context),
              input.loadedTons,
            );
            await this.freightRef.remember(context, { ...freight, ...result });
            return JSON.stringify(result);
          },
          {
            name: descriptor.name,
            description: descriptor.description,
            schema: z.object({
              freightId: z.string().uuid().optional(),
              freightRef: z.string().min(1).max(100).optional(),
              loadedTons: z.number().nonnegative().max(100000).optional(),
            }),
          },
        );

      case 'confirm_finished':
        return tool(
          async (input) => {
            const freight = await this.freightRef.resolve(context, {
              freightRef: input.freightRef,
              freightId: input.freightId,
            });
            const result = await this.freights.confirmFinished(freight.id, this.buildAgentUser(context));
            await this.freightRef.remember(context, { ...freight, ...result });
            return JSON.stringify(result);
          },
          {
            name: descriptor.name,
            description: descriptor.description,
            schema: z.object({
              freightId: z.string().uuid().optional(),
              freightRef: z.string().min(1).max(100).optional(),
            }),
          },
        );

      case 'cancel_freight':
        return tool(
          async (input) => {
            const freight = await this.freightRef.resolve(context, {
              freightRef: input.freightRef,
              freightId: input.freightId,
            });
            const result = await this.freights.cancel(freight.id, {
              reason: input.reason,
            }, this.buildAgentUser(context));
            await this.freightRef.remember(context, { ...freight, ...result });
            return JSON.stringify(result);
          },
          {
            name: descriptor.name,
            description: descriptor.description,
            schema: z.object({
              freightId: z.string().uuid().optional(),
              freightRef: z.string().min(1).max(100).optional(),
              reason: z.string().min(3).max(255),
            }),
          },
        );

      default:
        throw new Error(`Unsupported AI tool: ${descriptor.name}`);
    }
  }

  private buildAgentUser(context: AgentExecutionContext): any {
    const selectedCompanyId = (context.session?.flowState as any)?.selectedCompanyId;
    const dbUser = selectedCompanyId
      ? this.withSelectedCompany(context.user, selectedCompanyId)
      : context.user;

    return buildSyntheticUser(dbUser);
  }

  private withSelectedCompany(user: any, selectedCompanyId: string) {
    const memberships = Array.isArray(user?.memberships) ? user.memberships : [];
    const membership = memberships.find((item: any) => item.companyId === selectedCompanyId);
    if (!membership) return user;

    return {
      ...user,
      activeCompanyId: selectedCompanyId,
      companyId: selectedCompanyId,
      company: membership.company || user.company,
      userTypes: getCompanyTypes(membership.company),
    };
  }
}
