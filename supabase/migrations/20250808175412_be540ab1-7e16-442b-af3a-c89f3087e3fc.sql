-- Create agent_types table for predefined agent types
CREATE TABLE public.agent_types (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  capabilities TEXT[],
  required_integrations TEXT[],
  default_config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create agent_workflows table for visual flow representations
CREATE TABLE public.agent_workflows (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID,
  workflow_name TEXT NOT NULL,
  nodes JSONB DEFAULT '[]',
  edges JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create agent_memory table for context and memory management
CREATE TABLE public.agent_memory (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID,
  memory_type TEXT NOT NULL, -- 'context', 'user_preference', 'conversation', 'task_history'
  content JSONB NOT NULL,
  metadata JSONB DEFAULT '{}',
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create coordinator_sessions table for session management
CREATE TABLE public.coordinator_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  context JSONB DEFAULT '{}',
  active_agents TEXT[],
  last_activity TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Insert predefined agent types
INSERT INTO public.agent_types (name, description, capabilities, required_integrations, default_config) VALUES
('CoordinatorAgent', 'Central orchestrator for all agent coordination', 
 ARRAY['task_routing', 'agent_coordination', 'priority_management', 'status_monitoring'], 
 ARRAY['openai'], 
 '{"model": "gpt-4.1-2025-04-14", "temperature": 0.3, "max_tokens": 2000}'),

('MailAgent', 'Email management and automation', 
 ARRAY['email_reading', 'categorization', 'auto_response', 'calendar_integration'], 
 ARRAY['gmail', 'outlook', 'openai'], 
 '{"check_interval": 300, "auto_categorize": true, "priority_detection": true}'),

('CalendarAgent', 'Calendar management and scheduling', 
 ARRAY['calendar_reading', 'meeting_scheduling', 'conflict_detection', 'time_suggestions'], 
 ARRAY['google_calendar', 'outlook_calendar'], 
 '{"timezone": "Europe/Stockholm", "business_hours": [9, 17], "buffer_time": 15}'),

('MemoryAgent', 'Context and memory management', 
 ARRAY['context_storage', 'user_preferences', 'semantic_search', 'conversation_history'], 
 ARRAY['vector_db'], 
 '{"embedding_model": "text-embedding-3-small", "max_context_length": 4000}'),

('LLMCoreAgent', 'Central reasoning and decision making', 
 ARRAY['reasoning', 'planning', 'function_calling', 'response_generation'], 
 ARRAY['openai'], 
 '{"model": "gpt-4.1-2025-04-14", "temperature": 0.5, "reasoning_effort": "medium"}'),

('ReminderAgent', 'Smart reminder system', 
 ARRAY['reminder_creation', 'smart_timing', 'context_awareness', 'follow_up'], 
 ARRAY['calendar'], 
 '{"smart_timing": true, "context_based": true, "follow_up_enabled": true}'),

('ActionAgent', 'External action execution', 
 ARRAY['api_calls', 'web_requests', 'file_operations', 'webhook_triggers'], 
 ARRAY['various_apis'], 
 '{"rate_limiting": true, "error_handling": "retry", "timeout": 30}');

-- Enable RLS
ALTER TABLE public.agent_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coordinator_sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for agent_types (read-only for users)
CREATE POLICY "Users can view agent types" ON public.agent_types FOR SELECT USING (true);
CREATE POLICY "Only service role can modify agent types" ON public.agent_types FOR ALL USING (auth.role() = 'service_role');

-- RLS Policies for agent_workflows
CREATE POLICY "Users can view their workflows" ON public.agent_workflows 
  FOR SELECT USING (
    agent_id IN (SELECT id FROM public.agents WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can create workflows for their agents" ON public.agent_workflows 
  FOR INSERT WITH CHECK (
    agent_id IN (SELECT id FROM public.agents WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can update their workflows" ON public.agent_workflows 
  FOR UPDATE USING (
    agent_id IN (SELECT id FROM public.agents WHERE user_id = auth.uid())
  );

-- RLS Policies for agent_memory
CREATE POLICY "Users can view their agent memory" ON public.agent_memory 
  FOR SELECT USING (
    agent_id IN (SELECT id FROM public.agents WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can create memory for their agents" ON public.agent_memory 
  FOR INSERT WITH CHECK (
    agent_id IN (SELECT id FROM public.agents WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can update their agent memory" ON public.agent_memory 
  FOR UPDATE USING (
    agent_id IN (SELECT id FROM public.agents WHERE user_id = auth.uid())
  );

-- RLS Policies for coordinator_sessions
CREATE POLICY "Users can view their coordinator sessions" ON public.coordinator_sessions 
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create their coordinator sessions" ON public.coordinator_sessions 
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their coordinator sessions" ON public.coordinator_sessions 
  FOR UPDATE USING (auth.uid() = user_id);

-- Create update triggers
CREATE TRIGGER update_agent_workflows_updated_at
  BEFORE UPDATE ON public.agent_workflows
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_agent_memory_updated_at
  BEFORE UPDATE ON public.agent_memory
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_coordinator_sessions_updated_at
  BEFORE UPDATE ON public.coordinator_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();