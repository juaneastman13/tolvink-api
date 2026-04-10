import { Injectable, Logger } from '@nestjs/common';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { AgentResult, AgentRunInput } from '../contracts/agent.types';
import { ToolCatalogService } from '../tools/tool-catalog.service';

const MAX_TOOL_LOOPS = 4;

@Injectable()
export class OpenAiAgentService {
  private readonly logger = new Logger(OpenAiAgentService.name);
  private readonly modelName = process.env.OPENAI_AGENT_MODEL || 'gpt-4.1-mini';

  constructor(private toolCatalog: ToolCatalogService) {}

  async run(input: AgentRunInput): Promise<AgentResult> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for the OpenAI agent');
    }

    const tools = this.toolCatalog.buildTools(input.context, input.tools.map((tool) => tool.name));
    const toolMap = new Map(tools.map((item) => [item.name, item]));
    const llm = new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      model: this.modelName,
      temperature: 0.1,
      timeout: 30000,
    }).bindTools(tools);

    const messages: any[] = [
      new SystemMessage(this.buildSystemPrompt(input)),
      ...this.toHistoryMessages(input.context.session),
      new HumanMessage(input.message),
    ];

    const toolsUsed: string[] = [];
    const startedAt = Date.now();
    let response = await llm.invoke(messages);
    let loops = 0;

    while (Array.isArray(response.tool_calls) && response.tool_calls.length > 0) {
      if (loops >= MAX_TOOL_LOOPS) {
        throw new Error(`AI tool loop exceeded ${MAX_TOOL_LOOPS} iterations`);
      }
      loops += 1;
      messages.push(response);

      for (const toolCall of response.tool_calls) {
        const selectedTool = toolMap.get(toolCall.name);
        if (!selectedTool) {
          this.logger.warn(JSON.stringify({
            event: 'ai_tool_missing',
            tool: toolCall.name,
            channel: input.context.channel,
            phone: this.maskPhone(input.context.phone),
          }));
          messages.push(new ToolMessage({
            tool_call_id: toolCall.id || toolCall.name,
            content: `Tool ${toolCall.name} is not available in this turn.`,
          }));
          continue;
        }

        toolsUsed.push(toolCall.name);
        try {
          this.logger.log(JSON.stringify({
            event: 'ai_tool_call',
            tool: toolCall.name,
            loop: loops,
            channel: input.context.channel,
            phone: this.maskPhone(input.context.phone),
          }));
          const toolResult = await selectedTool.invoke(toolCall as any);
          if (toolResult instanceof ToolMessage) {
            messages.push(toolResult);
          } else {
            messages.push(new ToolMessage({
              tool_call_id: toolCall.id || toolCall.name,
              content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            }));
          }
        } catch (error: any) {
          this.logger.warn(JSON.stringify({
            event: 'ai_tool_failed',
            tool: toolCall.name,
            loop: loops,
            channel: input.context.channel,
            phone: this.maskPhone(input.context.phone),
            error: error?.message || 'unknown error',
          }));
          messages.push(new ToolMessage({
            tool_call_id: toolCall.id || toolCall.name,
            content: `Tool error: ${error?.message || 'unknown error'}`,
          }));
        }
      }

      response = await llm.invoke(messages);
    }

    const finalText = this.extractText(response);
    if (!finalText) {
      throw new Error('OpenAI agent returned an empty response');
    }

    if (input.onDelta) {
      input.onDelta(finalText, true);
    }

    this.logger.log(JSON.stringify({
      event: 'ai_openai_completed',
      channel: input.context.channel,
      phone: this.maskPhone(input.context.phone),
      routeMode: input.route.mode,
      routeIntent: input.route.intent,
      toolsExposed: input.tools.map((tool) => tool.name),
      toolsUsed,
      toolLoops: loops,
      durationMs: Date.now() - startedAt,
      model: this.modelName,
    }));

    return {
      text: finalText,
      route: input.route,
      buttons: [],
      model: this.modelName,
      toolsExposed: input.tools.map((tool) => tool.name),
      toolsUsed,
    };
  }

  private buildSystemPrompt(input: AgentRunInput): string {
    const selectedCompanyId = (input.context.session?.flowState as any)?.selectedCompanyId || 'none';
    return [
      'You are Tolvink AI, a production logistics assistant for grain freight operations.',
      'Be concise, operational, and do not invent data.',
      'Use tools whenever the answer depends on current freight, assignment, or company data.',
      'Before calling create_freight, ensure the user message already contains the required data or ask for the missing fields clearly.',
      `Route intent: ${input.route.intent}`,
      `Route risk: ${input.route.risk}`,
      `Route reason: ${input.route.reason}`,
      `Entity hints: ${JSON.stringify(input.route.entityHints || {})}`,
      `Channel: ${input.context.channel}`,
      `Selected company in session: ${selectedCompanyId}`,
      `Current date: ${new Date().toISOString()}`,
    ].join('\n');
  }

  private toHistoryMessages(session: any): Array<HumanMessage | AIMessage> {
    const state = (session?.flowState as any) || {};
    const aiMessages = Array.isArray(state.aiMessages) ? state.aiMessages : [];

    return aiMessages
      .filter((item: any) => item?.role === 'user' || item?.role === 'assistant')
      .map((item: any) => {
        const text = typeof item.content === 'string' ? item.content : '';
        return item.role === 'user' ? new HumanMessage(text) : new AIMessage(text);
      })
      .filter((message: any) => typeof message.content === 'string' && message.content.trim());
  }

  private extractText(message: AIMessage): string {
    if (typeof message.content === 'string') return message.content.trim();
    if (!Array.isArray(message.content)) return '';

    return message.content
      .map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .join('\n')
      .trim();
  }

  private maskPhone(phone: string): string {
    if (!phone || phone === 'web') return phone || 'unknown';
    return phone.length > 4 ? `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}` : phone;
  }
}
