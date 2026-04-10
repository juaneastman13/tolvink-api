import { Injectable } from '@nestjs/common';
import { getCompanyTypes } from '../../common/company-type-helpers';
import { AiToolDescriptor, AiRouteDecision, AgentExecutionContext } from '../contracts/agent.types';

@Injectable()
export class ToolFilterService {
  filter(route: AiRouteDecision, context: AgentExecutionContext, catalog: AiToolDescriptor[]): AiToolDescriptor[] {
    const currentCompanyTypes = this.resolveCurrentCompanyTypes(context);

    return catalog.filter((tool) => {
      if (tool.allowedChannels?.length && !tool.allowedChannels.includes(context.channel)) {
        return false;
      }

      if (!tool.allowedIntents.includes(route.intent) && !tool.allowedIntents.includes('unknown')) {
        return false;
      }

      if (route.toolDomains?.length && tool.domain && !route.toolDomains.includes(tool.domain)) {
        return false;
      }

      if (tool.requiredCompanyTypes?.length) {
        const hasAllowedType = tool.requiredCompanyTypes.some((type) => currentCompanyTypes.includes(type));
        if (!hasAllowedType) return false;
      }

      if (route.toolTags.length > 0) {
        const hasTagMatch = route.toolTags.some((tag) => tool.tags.includes(tag));
        if (!hasTagMatch && !tool.tags.includes('query')) return false;
      }

      if (tool.requiredEntityKeys?.length) {
        const entityHints = route.entityHints || {};
        const sessionState = (context.session?.flowState as any) || {};
        const missingRequiredEntity = tool.requiredEntityKeys.some((key) => {
          if (key === 'freightRef') {
            return !entityHints.freightRef && !sessionState._lastFreightId;
          }
          return !(entityHints as any)[key];
        });
        if (missingRequiredEntity) return false;
      }

      return true;
    });
  }

  private resolveCurrentCompanyTypes(context: AgentExecutionContext): string[] {
    const selectedCompanyId = (context.session?.flowState as any)?.selectedCompanyId;
    const memberships = Array.isArray(context.user?.memberships) ? context.user.memberships : [];
    if (selectedCompanyId) {
      const membership = memberships.find((item: any) => item.companyId === selectedCompanyId);
      if (membership?.company) return getCompanyTypes(membership.company);
    }
    return getCompanyTypes(context.user?.company);
  }
}
