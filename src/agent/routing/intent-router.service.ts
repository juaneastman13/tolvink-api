import { Injectable, Logger } from '@nestjs/common';

export type Intent = 'create_freight' | 'general';

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);

  private readonly createFreightRegex = /crear?\s+(un\s+)?flete|nuevo\s+flete|quiero\s+(mandar|fletar|transportar)|cargar\s+un\s+cami[oó]n|transportar\s+grano/i;

  classify(messageType: string, payload: any): Intent {
    // Non-text messages → general handler (images, locations, button replies all go through general)
    if (messageType !== 'text') {
      return 'general';
    }

    const body = payload?.body || '';
    if (!body) {
      return 'general';
    }

    // Simple keyword matching for "create freight"
    if (this.createFreightRegex.test(body)) {
      this.logger.debug(`Classified as 'create_freight': "${body.slice(0, 50)}..."`);
      return 'create_freight';
    }

    return 'general';
  }
}
