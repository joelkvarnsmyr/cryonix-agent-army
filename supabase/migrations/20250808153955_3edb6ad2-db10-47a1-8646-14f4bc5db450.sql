-- Enable RLS on agent_templates table
ALTER TABLE agent_templates ENABLE ROW LEVEL SECURITY;

-- Since agent_templates are shared templates, make them readable by all authenticated users
-- But only allow system/admin level modifications (we'll keep this simple for now)
CREATE POLICY "All authenticated users can view agent templates" 
ON agent_templates 
FOR SELECT 
TO authenticated
USING (true);

-- For now, restrict INSERT/UPDATE/DELETE to service role only
-- In a production system, you might want specific admin roles
CREATE POLICY "Only service role can modify agent templates" 
ON agent_templates 
FOR ALL 
USING (auth.role() = 'service_role');