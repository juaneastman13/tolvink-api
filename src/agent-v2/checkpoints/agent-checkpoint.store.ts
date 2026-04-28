import { AgentState } from '../schemas/agent-state.schema';

export type AgentCheckpoint = {
  threadId: string;
  state: Partial<AgentState>;
  updatedAt: string;
};

export interface AgentCheckpointStore {
  load(threadId: string): Promise<AgentCheckpoint | null>;
  save(threadId: string, state: AgentState): Promise<void>;
}

