import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

export interface ActiveFlow {
  flowName: string;
  step: string;
  slots: Record<string, any>;
  meta: Record<string, any>;
  startedAt: number;
}

@Injectable()
export class FlowStateService implements OnModuleDestroy {
  private readonly logger = new Logger(FlowStateService.name);

  private flows = new Map<string, ActiveFlow>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  private readonly FLOW_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpiredFlows(), this.CLEANUP_INTERVAL_MS);
    setTimeout(() => this.cleanupExpiredFlows(), 60_000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  getActiveFlow(phone: string): ActiveFlow | null {
    const flow = this.flows.get(phone);
    if (!flow) return null;

    // Check TTL
    if (Date.now() - flow.startedAt > this.FLOW_TTL_MS) {
      this.flows.delete(phone);
      this.logger.debug(`Flow expired for ${phone.slice(-4)}`);
      return null;
    }

    return flow;
  }

  setActiveFlow(phone: string, flow: ActiveFlow): void {
    this.flows.set(phone, {
      ...flow,
      startedAt: flow.startedAt || Date.now(),
    });
    this.logger.debug(`Set flow for ${phone.slice(-4)}: ${flow.flowName}/${flow.step}`);
  }

  updateActiveFlow(phone: string, partial: Partial<ActiveFlow>): void {
    const flow = this.flows.get(phone);
    if (!flow) return;

    Object.assign(flow, partial);
    this.logger.debug(`Updated flow for ${phone.slice(-4)}: ${flow.step}`);
  }

  clearActiveFlow(phone: string): void {
    if (this.flows.delete(phone)) {
      this.logger.debug(`Cleared flow for ${phone.slice(-4)}`);
    }
  }

  private cleanupExpiredFlows(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [phone, flow] of this.flows.entries()) {
      if (now - flow.startedAt > this.FLOW_TTL_MS) {
        this.flows.delete(phone);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`Cleaned up ${cleanedCount} expired flows`);
    }
  }
}
