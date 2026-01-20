import type { AgentId, AgentStatus, AgentMessage } from '@cryonix/types';

export interface AgentConfig {
  id: AgentId;
  name: string;
  description: string;
  enabled: boolean;
}

export abstract class BaseAgent {
  protected config: AgentConfig;
  protected status: AgentStatus = 'idle';
  protected messageQueue: AgentMessage[] = [];

  constructor(config: AgentConfig) {
    this.config = config;
  }

  abstract initialize(): Promise<void>;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract handleMessage(message: AgentMessage): Promise<void>;

  getStatus(): AgentStatus {
    return this.status;
  }

  setStatus(status: AgentStatus): void {
    this.status = status;
    this.emit('status_change', { agent_id: this.config.id, status });
  }

  getId(): AgentId {
    return this.config.id;
  }

  getName(): string {
    return this.config.name;
  }

  protected emit(event: string, data: any): void {
    // Event emitter implementation
    console.log(`[${this.config.id}] ${event}:`, data);
  }

  protected log(level: 'info' | 'warn' | 'error', message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    console[level](`[${timestamp}] [${this.config.id}] ${message}`, data || '');
  }
}
