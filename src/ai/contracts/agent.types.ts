export type AiChannel = 'whatsapp' | 'web';

export type AiIntent =
  | 'greeting'
  | 'general_help'
  | 'freight_query'
  | 'freight_create'
  | 'freight_update'
  | 'confirm_pending_action'
  | 'cancel_pending_action'
  | 'unknown';

export type AiRouteMode = 'direct_response' | 'openai_tools';

export type AiRiskLevel = 'low' | 'medium' | 'high';

export interface AiButton {
  id: string;
  title: string;
}

export interface AiRouteDecision {
  mode: AiRouteMode;
  intent: AiIntent;
  risk: AiRiskLevel;
  toolTags: string[];
  toolDomains?: string[];
  reason: string;
  shouldEscalate?: boolean;
  needsClarification?: boolean;
  clarificationQuestion?: string;
  confidence?: number;
  entityHints?: {
    freightRef?: string;
    plantRef?: string;
    fieldRef?: string;
    lotRef?: string;
    truckRef?: string;
    driverRef?: string;
  };
  directReply?: string;
}

export interface AiToolDescriptor {
  name: string;
  description: string;
  domain?: string;
  tags: string[];
  allowedChannels?: AiChannel[];
  allowedIntents: AiIntent[];
  requiredCompanyTypes?: string[];
  requiredEntityKeys?: string[];
  write?: boolean;
  strongModelOnly?: boolean;
  risk: AiRiskLevel;
}

export interface AgentExecutionContext {
  channel: AiChannel;
  phone: string;
  user: any;
  session: any;
}

export interface AgentRunInput {
  context: AgentExecutionContext;
  message: string;
  route: AiRouteDecision;
  tools: AiToolDescriptor[];
  onDelta?: (chunk: string, start?: boolean) => void;
}

export interface AgentResult {
  text: string;
  buttons?: AiButton[];
  navigate?: any;
  route: AiRouteDecision;
  toolsExposed: string[];
  toolsUsed: string[];
  model: string;
}

export interface PendingAction {
  kind: 'executor_confirmation';
  originalMessage: string;
  summary: string;
  route: AiRouteDecision;
  createdAt: string;
}
