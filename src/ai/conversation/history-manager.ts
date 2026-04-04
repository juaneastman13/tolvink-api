// =====================================================================
// TOLVINK — Conversation history management for Gemini format
// =====================================================================

import { Injectable } from '@nestjs/common';
import { MAX_HISTORY_MESSAGES } from '../core/constants';
import { GeminiMessage } from '../core/gemini.client';

@Injectable()
export class HistoryManagerService {

  /** Convert stored Anthropic-format messages to Gemini format. */
  convertAnthropicToGemini(messages: any[]): GeminiMessage[] {
    const geminiMessages: GeminiMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        // User messages: plain text or tool results
        if (typeof msg.content === 'string') {
          geminiMessages.push({
            role: 'user',
            parts: [{ text: msg.content }],
          });
        } else if (Array.isArray(msg.content)) {
          const parts: any[] = [];
          for (const block of msg.content) {
            if (block.type === 'text') {
              parts.push({ text: block.text });
            } else if (block.type === 'tool_result') {
              parts.push({
                functionResponse: {
                  name: block._toolName || 'unknown',
                  response: { result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) },
                },
              });
            }
          }
          if (parts.length > 0) {
            geminiMessages.push({ role: 'user', parts });
          }
        }
      } else if (msg.role === 'assistant') {
        // Assistant messages: text and/or tool calls
        if (typeof msg.content === 'string') {
          geminiMessages.push({
            role: 'model',
            parts: [{ text: msg.content }],
          });
        } else if (Array.isArray(msg.content)) {
          const parts: any[] = [];
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              parts.push({ text: block.text });
            } else if (block.type === 'tool_use') {
              parts.push({
                functionCall: {
                  name: block.name,
                  args: block.input || {},
                },
              });
            }
          }
          if (parts.length > 0) {
            geminiMessages.push({ role: 'model', parts });
          }
        }
      }
    }

    return geminiMessages;
  }

  /** Build Gemini-native messages from the session's conversation history. */
  buildGeminiHistory(storedMessages: any[]): GeminiMessage[] {
    // storedMessages may already be in Gemini format or Anthropic format
    if (storedMessages.length > 0 && storedMessages[0].parts) {
      // Already Gemini format
      return storedMessages;
    }
    return this.convertAnthropicToGemini(storedMessages);
  }

  /** Smart trim: keep recent messages, preserve tool call/result pairs. */
  smartTrimHistory(messages: GeminiMessage[]): GeminiMessage[] {
    if (messages.length <= MAX_HISTORY_MESSAGES) return messages;

    let trimmed = messages.slice(-MAX_HISTORY_MESSAGES);

    // Ensure we don't start with orphaned function responses
    while (trimmed.length > 0) {
      const first = trimmed[0];
      const hasFuncResponse = first.role === 'user' &&
        first.parts.some((p: any) => p.functionResponse);
      if (hasFuncResponse) {
        trimmed = trimmed.slice(1);
      } else {
        break;
      }
    }

    // Ensure we don't end with a function call without its response
    while (trimmed.length > 0) {
      const last = trimmed[trimmed.length - 1];
      const hasFuncCall = last.role === 'model' &&
        last.parts.some((p: any) => p.functionCall);
      if (hasFuncCall) {
        trimmed = trimmed.slice(0, -1);
      } else {
        break;
      }
    }

    // Guardrail: keep at least the last user message
    if (trimmed.length === 0 && messages.length > 0) {
      const lastUser = [...messages].reverse().find(m =>
        m.role === 'user' && !m.parts.some((p: any) => p.functionResponse),
      );
      if (lastUser) return [lastUser];
      return messages.slice(-1);
    }

    return trimmed;
  }

  /** Trim old function response content to prevent session bloat. */
  trimResponseContent(messages: GeminiMessage[]): GeminiMessage[] {
    return messages.map((msg, idx, arr) => {
      if (idx < arr.length - 8 && msg.role === 'user') {
        return {
          ...msg,
          parts: msg.parts.map((p: any) => {
            if (p.functionResponse && typeof p.functionResponse.response?.result === 'string' &&
                p.functionResponse.response.result.length > 800) {
              return {
                ...p,
                functionResponse: {
                  ...p.functionResponse,
                  response: { result: p.functionResponse.response.result.slice(0, 800) + '...[trimmed]' },
                },
              };
            }
            return p;
          }),
        };
      }
      return msg;
    });
  }
}
