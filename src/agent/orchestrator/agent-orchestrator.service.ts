import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { LlmService } from '../llm/llm.service';
import { ConversationService } from '../memory/conversation.service';
import { PrismaService } from '../../database/prisma.service';
import { FreightsService } from '../../freights/freights.service';
import { UserContext } from '../tools/context/user-context.service';
import { buildSystemPrompt } from '../prompts/system.prompt';
import { DraftStore } from './draft-store.service';
import { FREIGHT_TOOLS, ToolContext, ToolResult, executeConfirm, executeCancel } from './tools/freight-tools';

type MessageParam = Anthropic.Messages.MessageParam;

export type AgentReply =
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: Array<{ id: string; title: string }> }
  | { type: 'none' };

const MAX_TOOL_ROUNDS = 5;

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);
  private readonly toolMap: Map<string, (typeof FREIGHT_TOOLS)[number]>;
  private readonly toolSchemas: Anthropic.Messages.Tool[];

  constructor(
    private llm: LlmService,
    private conversation: ConversationService,
    private prisma: PrismaService,
    private freights: FreightsService,
    private drafts: DraftStore,
  ) {
    this.toolMap = new Map(FREIGHT_TOOLS.map((t) => [t.schema.name, t]));
    this.toolSchemas = FREIGHT_TOOLS.map((t) => t.schema);
  }

  /**
   * Main entry. Returns the reply to send to the user.
   */
  async handle(
    phone: string,
    type: string,
    payload: any,
    userCtx: UserContext | null,
  ): Promise<AgentReply> {
    // Shortcut: confirm/cancel button replies bypass the LLM and call the tool directly
    if (type === 'button_reply') {
      const btnId: string = payload?.id || '';
      if (btnId.startsWith('confirm:') || btnId.startsWith('cancel:')) {
        return this.handleConfirmCancelButton(phone, btnId, userCtx);
      }
    }

    const userMessage = this.parseMessageToText(type, payload);
    if (!userMessage) {
      return { type: 'text', text: 'Por ahora solo proceso textos, botones y ubicaciones. ¿Qué necesitás?' };
    }

    return this.runConversation(phone, userMessage, userCtx);
  }

  // ---------- Confirm / Cancel button shortcut ----------
  private async handleConfirmCancelButton(
    phone: string,
    btnId: string,
    userCtx: UserContext | null,
  ): Promise<AgentReply> {
    const [action, draftId] = btnId.split(':');
    const toolCtx: ToolContext = {
      phone,
      userCtx,
      prisma: this.prisma,
      freights: this.freights,
      drafts: this.drafts,
    };

    if (action === 'cancel') {
      executeCancel(draftId, toolCtx);
      const text = 'Cancelado. Avisame cuando quieras armar otro flete.';
      this.conversation.appendMessages(
        phone,
        { role: 'user', content: '[usuario canceló el flete pendiente]' },
        { role: 'assistant', content: text },
      );
      return { type: 'text', text };
    }

    // confirm
    const result = await executeConfirm(draftId, toolCtx);
    let text: string;
    if (result.ok) {
      text = result.data?.code
        ? `¡Listo! Flete ${result.data.code} creado. ✅\nTe aviso cuando haya novedades.`
        : '✅ Flete creado.';
    } else {
      text = (result as { ok: false; error: string }).error || 'No pude crear el flete. Probá de nuevo.';
    }
    this.conversation.appendMessages(
      phone,
      { role: 'user', content: '[usuario confirmó el flete pendiente]' },
      { role: 'assistant', content: text },
    );
    return { type: 'text', text };
  }

  // ---------- Main LLM loop ----------
  private async runConversation(
    phone: string,
    userMessage: string,
    userCtx: UserContext | null,
  ): Promise<AgentReply> {
    const history = this.conversation.getHistory(phone);
    const messages: MessageParam[] = [...history, { role: 'user', content: userMessage }];

    const systemPrompt = buildSystemPrompt(userCtx);
    const toolCtx: ToolContext = {
      phone,
      userCtx,
      prisma: this.prisma,
      freights: this.freights,
      drafts: this.drafts,
    };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let response: Anthropic.Messages.Message;
      try {
        response = await this.llm.complete(systemPrompt, messages, {
          model: 'sonnet',
          maxTokens: 1024,
          tools: this.toolSchemas,
        });
      } catch (error) {
        this.logger.error(`LLM error: ${error instanceof Error ? error.message : String(error)}`);
        return { type: 'text', text: 'Tuve un problema procesando tu mensaje. Probá de nuevo en un momento.' };
      }

      // Push assistant message (with tool_use blocks) into the conversation
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter((c) => c.type === 'tool_use') as Array<Extract<typeof response.content[number], { type: 'tool_use' }>>;

      if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
        // Done — return text
        const textBlock = response.content.find((c) => c.type === 'text');
        const finalText = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
        if (finalText) {
          this.conversation.appendMessages(
            phone,
            { role: 'user', content: userMessage },
            { role: 'assistant', content: finalText },
          );
          return { type: 'text', text: finalText };
        }
        return { type: 'text', text: 'No supe qué responder. ¿Podés repetir?' };
      }

      // Execute all tool calls
      const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];
      let pendingButtons: Extract<AgentReply, { type: 'buttons' }> | null = null;

      for (const tu of toolUses) {
        const def = this.toolMap.get(tu.name);
        let result: ToolResult;
        if (!def) {
          result = { ok: false, error: `Tool desconocida: ${tu.name}` };
        } else {
          try {
            result = await def.handler(tu.input, toolCtx);
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }

        let resultContent: string;
        let isError = false;
        if (result.ok) {
          this.logger.debug(`Tool ${tu.name} → ok`);
          resultContent = JSON.stringify(result.data);
          if (result.intercept) {
            pendingButtons = {
              type: 'buttons',
              text: result.intercept.text,
              buttons: result.intercept.buttons,
            };
          }
        } else {
          const errResult = result as { ok: false; error: string };
          this.logger.debug(`Tool ${tu.name} → err: ${errResult.error}`);
          resultContent = JSON.stringify({ error: errResult.error });
          isError = true;
        }

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: resultContent,
          ...(isError ? { is_error: true } : {}),
        });
      }

      // If a tool requested button interception, emit the buttons and stop the loop.
      // Persist the user msg + a synthetic assistant note so history stays consistent.
      if (pendingButtons) {
        this.conversation.appendMessages(
          phone,
          { role: 'user', content: userMessage },
          { role: 'assistant', content: pendingButtons.text },
        );
        return pendingButtons;
      }

      // Feed tool results back to the LLM and continue the loop
      messages.push({ role: 'user', content: toolResultBlocks });
    }

    this.logger.warn(`Reached MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) without final text`);
    return { type: 'text', text: 'Esto está saliendo más complejo de lo esperado. Probá rearmar tu pedido en un mensaje.' };
  }

  // ---------- Helpers ----------
  private parseMessageToText(type: string, payload: any): string | null {
    switch (type) {
      case 'text':
        return payload?.body || '';
      case 'button_reply':
        return payload?.title || payload?.id || '';
      case 'list_reply':
        return payload?.title || '';
      case 'location':
        if (payload?.latitude !== undefined && payload?.longitude !== undefined) {
          return `[Ubicación compartida: lat=${Number(payload.latitude).toFixed(5)}, lng=${Number(payload.longitude).toFixed(5)}]`;
        }
        return null;
      case 'image':
      case 'audio':
      case 'document':
        return null;
      default:
        return null;
    }
  }
}
