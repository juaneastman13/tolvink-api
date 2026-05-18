import { Injectable, Logger } from '@nestjs/common';
import { LlmService, AgentLlmError } from '../llm/llm.service';
import { ConversationService, ConversationMessage } from '../memory/conversation.service';
import { buildSystemPrompt } from '../prompts/system.prompt';
import type Anthropic from '@anthropic-ai/sdk';

export type AgentReply =
  | { type: 'text'; text: string }
  | { type: 'none' };

interface MessagePayload {
  [key: string]: any;
  body?: string;
  title?: string;
  latitude?: number;
  longitude?: number;
  mime_type?: string;
}

@Injectable()
export class AgentHandlerService {
  private readonly logger = new Logger(AgentHandlerService.name);

  constructor(
    private llm: LlmService,
    private conversation: ConversationService,
  ) {}

  /**
   * Handle an incoming WhatsApp message.
   * Converts message to text, gets conversation history,
   * calls Claude, updates history, returns reply.
   */
  async handle(phone: string, type: string, payload: MessagePayload): Promise<AgentReply> {
    try {
      // Parse message to user-facing text
      const userMessage = this.parseMessagePayload(type, payload);
      if (!userMessage) {
        return {
          type: 'text',
          text: 'Por ahora solo proceso textos, botones y ubicaciones. ¿Qué necesitás?',
        };
      }

      // Get conversation history
      const history = this.conversation.getHistory(phone);

      // Build messages for Claude
      const messages: Anthropic.Messages.MessageParam[] = [
        ...history,
        { role: 'user', content: userMessage },
      ];

      this.logger.debug(`[${phone.slice(-4)}] User message: ${userMessage.substring(0, 80)}`);

      // Call Claude
      const systemPrompt = buildSystemPrompt();
      let assistantResponse: string;

      try {
        assistantResponse = await this.llm.chat(systemPrompt, messages);
      } catch (error) {
        if (error instanceof AgentLlmError) {
          this.logger.error(`LLM error for ${phone}: ${error.message}`);
        } else {
          this.logger.error(`Unexpected error calling LLM: ${error instanceof Error ? error.message : String(error)}`);
        }
        return {
          type: 'text',
          text: 'Tuve un problema procesando tu mensaje. Intentá de nuevo en un momento.',
        };
      }

      if (!assistantResponse) {
        this.logger.warn(`Empty response from LLM for ${phone}`);
        return {
          type: 'text',
          text: 'Parece que no llegué a procesar bien tu mensaje. ¿Podés repetir?',
        };
      }

      this.logger.debug(`[${phone.slice(-4)}] Assistant response: ${assistantResponse.substring(0, 80)}`);

      // Store conversation history
      this.conversation.appendMessages(
        phone,
        { role: 'user', content: userMessage },
        { role: 'assistant', content: assistantResponse },
      );

      return {
        type: 'text',
        text: assistantResponse,
      };
    } catch (error) {
      this.logger.error(
        `Unhandled error in handler: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : '',
      );
      return {
        type: 'text',
        text: 'Algo no salió bien. Intentá de nuevo.',
      };
    }
  }

  /**
   * Parse WhatsApp message payload to plain text.
   * Handles: text, button_reply, list_reply, location.
   * Returns null for unsupported types (image, audio, document).
   */
  private parseMessagePayload(type: string, payload: MessagePayload): string | null {
    switch (type) {
      case 'text':
        return payload.body || '';

      case 'button_reply':
        return payload.title || '';

      case 'list_reply':
        return payload.title || '';

      case 'location': {
        const { latitude, longitude } = payload;
        if (latitude !== undefined && longitude !== undefined) {
          return `[Ubicación enviada: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}]`;
        }
        return null;
      }

      case 'image':
      case 'audio':
      case 'document':
        // Unsupported types
        return null;

      default:
        this.logger.warn(`Unknown message type: ${type}`);
        return null;
    }
  }
}
