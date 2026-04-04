// =====================================================================
// TOLVINK — Tool type definitions
// =====================================================================

export interface ToolContext {
  user: any;
  synUser: any;
  session: any;
  plantAccessMap?: Map<string, string>;
}

export type ToolHandler = (input: any, ctx: ToolContext) => Promise<string>;

export interface ToolHandlerMap {
  [toolName: string]: ToolHandler;
}
