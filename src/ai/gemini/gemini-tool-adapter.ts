// =====================================================================
// TOLVINK — Gemini Tool Adapter
// Converts Anthropic tool definitions → Google Gemini functionDeclarations
// =====================================================================

import { AiToolDefinition } from '../ai-tool-definitions';

/**
 * Google Gemini function declaration format.
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * Convert a single Anthropic tool definition to Gemini format.
 * Main differences:
 * - Anthropic uses `input_schema` → Gemini uses `parameters`
 * - Anthropic always has `type: 'object'` → Gemini uses `type: 'OBJECT'` (uppercase)
 * - Anthropic property types are lowercase → Gemini uses uppercase
 * - Gemini `required` is optional (omit if empty array)
 */
function convertPropertyType(prop: any): any {
  const result: any = {};

  // Convert type to uppercase for Gemini
  if (prop.type) {
    result.type = prop.type.toUpperCase();
  }

  if (prop.description) {
    result.description = prop.description;
  }

  // Enum values
  if (prop.enum) {
    result.enum = prop.enum;
  }

  // Array items
  if (prop.items) {
    result.items = convertPropertyType(prop.items);
  }

  // Nested object properties
  if (prop.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(prop.properties)) {
      result.properties[key] = convertPropertyType(val);
    }
    if (prop.required?.length > 0) {
      result.required = prop.required;
    }
  }

  return result;
}

export function convertToolToGemini(tool: AiToolDefinition): GeminiFunctionDeclaration {
  const declaration: GeminiFunctionDeclaration = {
    name: tool.name,
    description: tool.description,
  };

  const schema = tool.input_schema;
  if (schema && Object.keys(schema.properties).length > 0) {
    const convertedProps: Record<string, any> = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      convertedProps[key] = convertPropertyType(val);
    }

    declaration.parameters = {
      type: 'OBJECT',
      properties: convertedProps,
    };
    if (schema.required?.length > 0) {
      declaration.parameters.required = schema.required;
    }
  }

  return declaration;
}

/**
 * Convert all Anthropic tool definitions to Gemini format.
 * Returns a single tool object with all function declarations (Gemini groups them).
 */
export function convertAllToolsToGemini(tools: AiToolDefinition[]): { functionDeclarations: GeminiFunctionDeclaration[] } {
  return {
    functionDeclarations: tools.map(convertToolToGemini),
  };
}
