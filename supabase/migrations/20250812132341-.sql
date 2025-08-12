-- Create tables for autonomous email ingestion via Nylas
-- email_messages stores normalized messages
-- email_sync_state tracks pagination/cursor per user/provider

-- Create email_messages table
CREATE TABLE IF NOT EXISTS public.email_messages (
  id TEXT NOT NULL,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL DEFAULT 'nylas',
  grant_id TEXT,
  thread_id TEXT,
  subject TEXT,
  sender TEXT,
  recipients JSONB DEFAULT '[]'::jsonb,
  snippet TEXT,
  body_preview TEXT,
  message_date TIMESTAMPTZ,
  is_read BOOLEAN,
  raw JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_email_messages_user_date ON public.email_messages (user_id, message_date DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_provider ON public.email_messages (provider);

-- Enable RLS and policies
ALTER TABLE public.email_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own emails" ON public.email_messages;
DROP POLICY IF EXISTS "Users can insert their own emails" ON public.email_messages;
DROP POLICY IF EXISTS "Users can update their own emails" ON public.email_messages;

CREATE POLICY "Users can view their own emails"
ON public.email_messages FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own emails"
ON public.email_messages FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own emails"
ON public.email_messages FOR UPDATE
USING (auth.uid() = user_id);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trg_email_messages_updated_at ON public.email_messages;
CREATE TRIGGER trg_email_messages_updated_at
BEFORE UPDATE ON public.email_messages
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Create sync state table
CREATE TABLE IF NOT EXISTS public.email_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider TEXT NOT NULL DEFAULT 'nylas',
  grant_id TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'idle', -- idle | running | error
  total_synced INTEGER NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_email_sync_state_user ON public.email_sync_state (user_id);

ALTER TABLE public.email_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own sync state" ON public.email_sync_state;
DROP POLICY IF EXISTS "Users can insert their own sync state" ON public.email_sync_state;
DROP POLICY IF EXISTS "Users can update their own sync state" ON public.email_sync_state;

CREATE POLICY "Users can view their own sync state"
ON public.email_sync_state FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own sync state"
ON public.email_sync_state FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own sync state"
ON public.email_sync_state FOR UPDATE
USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS trg_email_sync_state_updated_at ON public.email_sync_state;
CREATE TRIGGER trg_email_sync_state_updated_at
BEFORE UPDATE ON public.email_sync_state
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
