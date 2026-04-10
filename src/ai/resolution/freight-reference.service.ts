import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CompanyResolutionService } from '../../common/services/company-resolution.service';
import { buildSyntheticUser } from '../../common/build-synthetic-user';
import { getCompanyTypes } from '../../common/company-type-helpers';
import { FreightsService } from '../../freights/freights.service';
import { AgentMemoryService } from '../memory/agent-memory.service';
import { AgentExecutionContext } from '../contracts/agent.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FREIGHT_CODE_RE = /^[A-Z0-9.-]{4,}$/i;

@Injectable()
export class FreightReferenceService {
  constructor(
    private freights: FreightsService,
    private companyRes: CompanyResolutionService,
    private memory: AgentMemoryService,
  ) {}

  async resolve(context: AgentExecutionContext, input?: { freightRef?: string; freightId?: string }) {
    const freightRef = (input?.freightRef || input?.freightId || '').trim();
    const state = (context.session?.flowState as any) || {};
    const agentUser = this.buildAgentUser(context);
    const companyIds = await this.companyRes.resolveAllCompanyIds(agentUser);

    if (!freightRef || this.isContextualReference(freightRef)) {
      if (state._lastFreightId) {
        const freight = await this.freights.findOne(state._lastFreightId, companyIds, agentUser);
        await this.remember(context, freight);
        return freight;
      }
      throw new BadRequestException('Necesito identificar a que flete te referis. Decime el codigo o buscame primero el flete.');
    }

    if (UUID_RE.test(freightRef)) {
      const freight = await this.freights.findOne(freightRef, companyIds, agentUser);
      await this.remember(context, freight);
      return freight;
    }

    const searchResult = await this.freights.findAll(agentUser, {
      search: freightRef,
      limit: 5,
    });
    const matches = Array.isArray(searchResult?.data) ? searchResult.data : [];

    if (matches.length === 0) {
      throw new NotFoundException(`No encontre ningun flete para "${freightRef}"`);
    }

    const exactCode = FREIGHT_CODE_RE.test(freightRef)
      ? matches.find((item: any) => typeof item.code === 'string' && item.code.toLowerCase() === freightRef.toLowerCase())
      : null;

    const selected = exactCode || (matches.length === 1 ? matches[0] : null);
    if (!selected) {
      const options = matches
        .slice(0, 3)
        .map((item: any) => `${item.code} (${item.originName} -> ${item.destName})`)
        .join('; ');
      throw new BadRequestException(`Encontre varios fletes para "${freightRef}". Decime cual: ${options}`);
    }

    const freight = await this.freights.findOne(selected.id, companyIds, agentUser);
    await this.remember(context, freight);
    return freight;
  }

  async remember(context: AgentExecutionContext, freight: any) {
    if (!context.session?.id || !freight?.id) return;
    await this.memory.mergeState(context.session.id, {
      _lastFreightId: freight.id,
      _lastFreightCode: freight.code || null,
      _lastFreightSummary: freight.code
        ? `${freight.code}: ${freight.originName || '-'} -> ${freight.destName || '-'}`
        : null,
    });
  }

  private isContextualReference(value: string) {
    return /^(ese|esa|este|esta|el ultimo|el último|ultimo|último|el de hoy|ese flete|ese viaje)$/i.test(value.trim());
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
