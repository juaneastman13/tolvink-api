import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';

export type Intent = 'create_freight' | 'general';

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);

  // Fast keyword pre-filter — if it hits, no need to call LLM.
  private readonly createFreightRegex = /crear?\s+(un\s+)?flete|nuevo\s+flete|quiero\s+(mandar|fletar|transportar|solicitar)|cargar\s+un\s+cami[oó]n|transportar\s+grano|necesito\s+(un\s+)?(flete|cami[oó]n)|mover\s+(grano|carga|soja|ma[ií]z|trigo)/i;

  constructor(private llm: LlmService) {}

  /**
   * Classify user intent.
   * 1. Non-text → general
   * 2. Regex match → create_freight (fast path)
   * 3. Otherwise → ask Haiku
   */
  async classify(messageType: string, payload: any): Promise<Intent> {
    if (messageType !== 'text') return 'general';

    const body: string = (payload?.body || '').trim();
    if (!body) return 'general';

    if (this.createFreightRegex.test(body)) {
      this.logger.debug(`Regex matched create_freight: "${body.slice(0, 60)}"`);
      return 'create_freight';
    }

    // LLM fallback for ambiguous phrasing
    try {
      const prompt = `Sos un clasificador de intenciones para un sistema de logística agropecuaria.
Dado un mensaje del usuario, respondé SOLO con una de estas dos palabras (sin nada más):
- create_freight: si el usuario quiere crear, solicitar, pedir, armar, generar o coordinar un flete / transporte / camión para mover carga.
- general: para saludos, consultas, dudas, o cualquier otra cosa.

Respondé con UNA sola palabra.`;

      const response = await this.llm.chat(
        prompt,
        [{ role: 'user', content: body }],
        { model: 'haiku', maxTokens: 10, temperature: 0 },
      );

      const normalized = response.trim().toLowerCase();
      if (normalized.includes('create_freight')) {
        this.logger.debug(`LLM classified as create_freight: "${body.slice(0, 60)}"`);
        return 'create_freight';
      }
      return 'general';
    } catch (error) {
      this.logger.warn(`Intent classifier failed, defaulting to general: ${error instanceof Error ? error.message : String(error)}`);
      return 'general';
    }
  }
}
