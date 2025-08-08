-- Extend agents table to support team-based agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id uuid;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_role text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS team_position integer DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_integrations jsonb DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS memory_context jsonb DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS interaction_style jsonb DEFAULT '{}'::jsonb;

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_agents_parent_agent_id ON agents(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_agent_role ON agents(agent_role);
CREATE INDEX IF NOT EXISTS idx_agents_user_id_status ON agents(user_id, status);

-- Create agent_conversations table for chat history
CREATE TABLE IF NOT EXISTS agent_conversations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  agent_id uuid,
  session_id text NOT NULL,
  message_type text NOT NULL CHECK (message_type IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS on agent_conversations
ALTER TABLE agent_conversations ENABLE ROW LEVEL SECURITY;

-- Create policies for agent_conversations
CREATE POLICY "Users can view their own conversations" 
ON agent_conversations 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own conversations" 
ON agent_conversations 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own conversations" 
ON agent_conversations 
FOR UPDATE 
USING (auth.uid() = user_id);

-- Create agent_templates table for predefined agent types
CREATE TABLE IF NOT EXISTS agent_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text,
  agent_type text NOT NULL,
  default_configuration jsonb DEFAULT '{}'::jsonb,
  required_integrations text[] DEFAULT '{}',
  prompt_template text,
  interaction_style jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Insert Joel's predefined agent templates
INSERT INTO agent_templates (name, description, agent_type, default_configuration, required_integrations, prompt_template, interaction_style) VALUES 
(
  'SchedulerAgent',
  'Analyserar kalender, mail och todos för daglig överblick och optimering',
  'scheduler',
  '{"tools": ["calendar", "email", "tasks"], "proactive": true, "optimization_focus": ["time_gaps", "priority_sorting"]}',
  '{"google_calendar", "gmail", "notion"}',
  'Du är en vänlig men effektiv schemaläggningsassistent. Din uppgift är att ge användaren en tydlig daglig överblick och föreslå optimeringar. Börja alltid med "Din dag ser ut så här..." och var konkret och actionable.',
  '{"tone": "friendly_efficient", "style": "structured", "proactivity": "high"}'
),
(
  'InboxAgent', 
  'Hanterar inkommande e-post, sammanfattar, sorterar och föreslår svar',
  'email_manager',
  '{"tools": ["email"], "learning": true, "auto_categorization": true}',
  '{"gmail"}',
  'Du är en intelligent e-postassistent som hjälper användaren att hantera sin inkorg effektivt. Sammanfatta viktiga meddelanden, föreslå åtgärder och lär dig användarens kommunikationsstil för att föreslå passande svar.',
  '{"tone": "professional_adaptive", "style": "concise", "learning_mode": true}'
),
(
  'MessengerAgent',
  'Övervakar Facebook Messenger, extraherar viktiga meddelanden och föreslår svar', 
  'messenger',
  '{"tools": ["messenger"], "social_context": true, "relationship_tracking": true}',
  '{"facebook_graph"}',
  'Du är en social kommunikationsassistent som hjälper användaren att hålla koll på viktiga konversationer i Messenger. Fokusera på relationer och social kontext.',
  '{"tone": "casual_warm", "style": "social", "relationship_awareness": true}'
),
(
  'SMSAgent',
  'Övervakar SMS, svarar på enkla meddelanden och flaggar viktiga',
  'sms_handler', 
  '{"tools": ["sms"], "auto_reply": true, "urgency_detection": true}',
  '{"twilio"}',
  'Du är en SMS-assistent som hjälper användaren att hantera textmeddelanden effektivt. Identifiera viktiga meddelanden och föreslå snabba, passande svar.',
  '{"tone": "brief_friendly", "style": "concise", "urgency_aware": true}'
),
(
  'ReminderAgent',
  'Skapar, hanterar och triggar påminnelser baserat på naturligt språk',
  'reminder_system',
  '{"tools": ["reminders", "location"], "natural_language": true, "context_aware": true}',
  '{"google_tasks", "notion"}', 
  'Du är en intelligent påminnelseassistent som förstår naturligt språk och kontext. Skapa smarta påminnelser som anpassar sig efter användarens rutiner och behov.',
  '{"tone": "helpful_proactive", "style": "contextual", "timing_smart": true}'
),
(
  'ContextManagerAgent',
  'Håller koll på helheten och förmedlar kontext mellan andra agenter',
  'context_manager',
  '{"tools": ["memory", "coordination"], "cross_agent": true, "persistent_memory": true}',
  '{"notion", "internal_db"}',
  'Du är en koordinerande agent som håller koll på användarens övergripande kontext, projekt och tillstånd. Du hjälper andra agenter att förstå helheten och koordinerar deras arbete.',
  '{"tone": "wise_coordinating", "style": "holistic", "memory_focused": true}'
);

-- Add trigger for updating timestamps
CREATE TRIGGER update_agent_conversations_updated_at
BEFORE UPDATE ON agent_conversations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_agent_templates_updated_at  
BEFORE UPDATE ON agent_templates
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();