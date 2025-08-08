import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface AgentType {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  required_integrations: string[];
  default_config: any;
  is_active: boolean;
}

export interface Agent {
  id: string;
  name: string;
  agent_type: string;
  status: 'active' | 'inactive' | 'thinking' | 'working';
  description: string;
  configuration: any;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export interface AgentMemory {
  id: string;
  agent_id: string;
  memory_type: 'context' | 'user_preference' | 'conversation' | 'task_history';
  content: any;
  metadata: any;
  expires_at?: string;
}

export interface CoordinatorSession {
  id: string;
  user_id: string;
  session_id: string;
  context: any;
  active_agents: string[];
  last_activity: string;
}

export const useAgentSystem = () => {
  const { user } = useAuth();
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [currentSession, setCurrentSession] = useState<CoordinatorSession | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) {
      fetchAgentTypes();
      fetchUserAgents();
    }
  }, [user]);

  const fetchAgentTypes = async () => {
    try {
      const { data, error } = await supabase
        .from('agent_types')
        .select('*')
        .eq('is_active', true)
        .order('name');
      
      if (error) throw error;
      setAgentTypes(data || []);
    } catch (error) {
      console.error('Error fetching agent types:', error);
    }
  };

  const fetchUserAgents = async () => {
    try {
      const { data, error } = await supabase
        .from('agents')
        .select('*')
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setAgents((data || []).map(agent => ({
        ...agent,
        status: agent.status as 'active' | 'inactive' | 'thinking' | 'working'
      })));
    } catch (error) {
      console.error('Error fetching user agents:', error);
    }
  };

  const createAgent = async (agentTypeId: string, customName?: string) => {
    if (!user) return null;
    
    setLoading(true);
    try {
      const agentType = agentTypes.find(t => t.id === agentTypeId);
      if (!agentType) throw new Error('Agent type not found');

      const agentData = {
        name: customName || agentType.name,
        agent_type: agentType.name,
        description: agentType.description,
        status: 'inactive',
        configuration: agentType.default_config,
        user_id: user.id
      };

      const { data, error } = await supabase
        .from('agents')
        .insert([agentData])
        .select()
        .single();

      if (error) throw error;
      
      await fetchUserAgents();
      return data;
    } catch (error) {
      console.error('Error creating agent:', error);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const createCoordinatorSession = async (sessionId: string) => {
    if (!user) return null;

    try {
      const sessionData = {
        user_id: user.id,
        session_id: sessionId,
        context: {},
        active_agents: [],
        last_activity: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from('coordinator_sessions')
        .insert([sessionData])
        .select()
        .single();

      if (error) throw error;
      setCurrentSession(data);
      return data;
    } catch (error) {
      console.error('Error creating coordinator session:', error);
      return null;
    }
  };

  const updateSessionContext = async (sessionId: string, context: any) => {
    try {
      const { data, error } = await supabase
        .from('coordinator_sessions')
        .update({ 
          context,
          last_activity: new Date().toISOString()
        })
        .eq('session_id', sessionId)
        .eq('user_id', user?.id)
        .select()
        .single();

      if (error) throw error;
      setCurrentSession(data);
      return data;
    } catch (error) {
      console.error('Error updating session context:', error);
      return null;
    }
  };

  const storeAgentMemory = async (
    agentId: string, 
    memoryType: AgentMemory['memory_type'], 
    content: any, 
    metadata: any = {},
    expiresAt?: string
  ) => {
    try {
      const memoryData = {
        agent_id: agentId,
        memory_type: memoryType,
        content,
        metadata,
        expires_at: expiresAt
      };

      const { data, error } = await supabase
        .from('agent_memory')
        .insert([memoryData])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error storing agent memory:', error);
      return null;
    }
  };

  const getAgentMemory = async (agentId: string, memoryType?: string) => {
    try {
      let query = supabase
        .from('agent_memory')
        .select('*')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false });

      if (memoryType) {
        query = query.eq('memory_type', memoryType);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching agent memory:', error);
      return [];
    }
  };

  const activateAgent = async (agentId: string) => {
    try {
      const { data, error } = await supabase
        .from('agents')
        .update({ status: 'active' })
        .eq('id', agentId)
        .eq('user_id', user?.id)
        .select()
        .single();

      if (error) throw error;
      await fetchUserAgents();
      return data;
    } catch (error) {
      console.error('Error activating agent:', error);
      return null;
    }
  };

  const deactivateAgent = async (agentId: string) => {
    try {
      const { data, error } = await supabase
        .from('agents')
        .update({ status: 'inactive' })
        .eq('id', agentId)
        .eq('user_id', user?.id)
        .select()
        .single();

      if (error) throw error;
      await fetchUserAgents();
      return data;
    } catch (error) {
      console.error('Error deactivating agent:', error);
      return null;
    }
  };

  return {
    agentTypes,
    agents,
    currentSession,
    loading,
    createAgent,
    createCoordinatorSession,
    updateSessionContext,
    storeAgentMemory,
    getAgentMemory,
    activateAgent,
    deactivateAgent,
    fetchUserAgents
  };
};