import { Injectable, Logger } from '@nestjs/common';
import { FlowStateService, ActiveFlow } from '../memory/flow-state.service';
import { CreateFreightFlow } from './create-freight/create-freight.flow';
import { AgentReply } from '../whatsapp/agent-handler.service';
import { UserContext } from '../tools/context/user-context.service';
import { CreateFreightState } from './create-freight/create-freight.types';

@Injectable()
export class FlowManagerService {
  private readonly logger = new Logger(FlowManagerService.name);

  constructor(
    private flowState: FlowStateService,
    private createFreightFlow: CreateFreightFlow,
  ) {}

  /**
   * Start a new flow.
   */
  async start(flowName: string, phone: string, userCtx: UserContext): Promise<AgentReply> {
    switch (flowName) {
      case 'create_freight': {
        const initialState: CreateFreightState = {
          step: 'selecting_company',
          slots: {},
        };

        const activeFlow: ActiveFlow = {
          flowName: 'create_freight',
          step: 'selecting_company',
          slots: {},
          meta: {},
          startedAt: Date.now(),
        };

        this.flowState.setActiveFlow(phone, activeFlow);

        const { reply, nextState } = await this.createFreightFlow.handle(phone, 'text', {}, initialState, userCtx);

        // Update state after handling (in case handleSelectingCompany auto-selects company)
        this.flowState.updateActiveFlow(phone, {
          step: nextState.step,
          slots: nextState.slots,
          meta: nextState.meta || {},
        });

        return reply;
      }

      default:
        return { type: 'text', text: 'Flujo no reconocido.' };
    }
  }

  /**
   * Route message to active flow.
   */
  async route(
    phone: string,
    activeFlow: ActiveFlow,
    type: string,
    payload: any,
    userCtx: UserContext,
  ): Promise<AgentReply> {
    switch (activeFlow.flowName) {
      case 'create_freight': {
        const state: CreateFreightState = {
          step: (activeFlow.step as any) || 'opening',
          slots: activeFlow.slots || {},
        };

        const { reply, nextState } = await this.createFreightFlow.handle(phone, type, payload, state, userCtx);

        // Check if flow is done
        if (nextState.step === 'confirming' && type === 'button_reply' && (payload.id === 'confirm' || payload.id === 'cancel')) {
          // Clear flow after confirm/cancel
          this.flowState.clearActiveFlow(phone);
          this.logger.debug(`Cleared flow for ${phone.slice(-4)} after completion`);
        } else {
          // Update state for next message
          this.flowState.updateActiveFlow(phone, {
            step: nextState.step,
            slots: nextState.slots,
            meta: nextState.meta || activeFlow.meta,
          });
        }

        return reply;
      }

      default:
        this.logger.warn(`Unknown flow: ${activeFlow.flowName}`);
        this.flowState.clearActiveFlow(phone);
        return { type: 'text', text: 'Algo salió mal. Intentá de nuevo.' };
    }
  }
}
