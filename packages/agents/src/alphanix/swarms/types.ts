export type SwarmType = 'osint' | 'backtest' | 'macro' | 'altdata' | 'esg' | 'sentiment' | 'custom';
export type SwarmPriority = 'low' | 'normal' | 'high' | 'critical';
export type SwarmStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SwarmRequest {
  id: string;
  type: SwarmType;
  requester: { podId: string; role: string };
  task: string;
  params: Record<string, unknown>;
  workerCount: number;
  maxDuration: number;  // ms
  priority: SwarmPriority;
}

export interface SwarmResult {
  requestId: string;
  status: SwarmStatus;
  data: unknown;
  workersUsed: number;
  durationMs: number;
  errors: string[];
}

export interface SwarmWorkerTask {
  id: string;
  swarmId: string;
  type: SwarmType;
  params: Record<string, unknown>;
}

export interface SwarmWorkerResult {
  taskId: string;
  success: boolean;
  data: unknown;
  error?: string;
  durationMs: number;
}
