// =====================================================================
// TOLVINK — Agent Service (stub — LLM connection pending)
// Tools and handlers are ready. This stub will be replaced by Claude integration.
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  isEnabled(): boolean {
    return false;
  }

  async chat(
    _phone: string,
    _userMessage: string,
    _user: any,
    _session: any,
    _onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }> }> {
    return { text: 'El asistente esta en mantenimiento. Usa la web: https://tolvink.com' };
  }
}
