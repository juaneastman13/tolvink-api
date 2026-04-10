// =====================================================================
// TOLVINK — AgentService stub (agent disabled, pending rebuild)
// Returns maintenance message for all chat requests
// =====================================================================

import { Injectable } from '@nestjs/common';

@Injectable()
export class AgentService {
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
