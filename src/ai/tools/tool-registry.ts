// =====================================================================
// TOLVINK — Tool registry: maps tool names to handler services
// =====================================================================

import { Injectable } from '@nestjs/common';
import { ALL_TOOL_DEFINITIONS } from './declarations/all-tools';

@Injectable()
export class ToolRegistryService {
  private readonly definitions = ALL_TOOL_DEFINITIONS;

  getAllDefinitions() {
    return this.definitions;
  }

  getDefinition(name: string) {
    return this.definitions.find(t => t.name === name);
  }

  getNames(): string[] {
    return this.definitions.map(t => t.name);
  }
}
