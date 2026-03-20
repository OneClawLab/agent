/**
 * Shared types for Agent Runtime
 */

export interface ReplyContext {
  channel_type: 'external' | 'internal';
  channel_id: string;
  peer_id: string;
  session_id?: string;
  visibility?: string;
  source_agent_id?: string;
}

export interface InboxMessage {
  eventId: string;
  type: 'message';
  source: string;
  content: {
    text: string;
    reply_context: ReplyContext;
    [key: string]: unknown;
  };
  timestamp: string;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

export type RoutingMode = 'per-peer' | 'per-channel' | 'per-agent';

export interface AgentConfig {
  agent_id: string;
  kind: 'system' | 'user';
  pai: { provider: string; model: string };
  inbox: { path: string };
  routing: { default: RoutingMode };
  outbound: Array<{ thread_pattern: string; via: string }>;
  retry?: { max_attempts?: number };
  deliver?: { max_attempts?: number };
}
