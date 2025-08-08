import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export interface Agent {
  id: string;
  name: string;
  description: string;
  agent_type: string;
  status: string;
  configuration: any;
  performance_data: any;
  last_activity: string | null;
  created_at: string;
  updated_at: string;
  user_id: string;
  parent_agent_id?: string;
  agent_role?: string;
  team_position?: number;
  api_integrations?: any;
  memory_context?: any;
  interaction_style?: any;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  agent_type: string;
  default_configuration: any;
  required_integrations: string[];
  prompt_template: string;
  interaction_style: any;
}

export const useAgents = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  const fetchAgents = async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from('agents')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setAgents((data || []).map((agent: any) => ({
        ...agent,
        api_integrations: Array.isArray(agent.api_integrations) ? agent.api_integrations : []
      })));
    } catch (error) {
      console.error('Error fetching agents:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchTemplates = async () => {
    try {
      const { data, error } = await supabase
        .from('agent_templates')
        .select('*')
        .order('name');
      
      if (error) throw error;
      setTemplates(data || []);
    } catch (error) {
      console.error('Error fetching templates:', error);
    }
  };

  const createAgent = async (agentData: { 
    name: string; 
    description: string; 
    agent_type: string; 
    status?: string; 
    configuration?: any;
    parent_agent_id?: string;
    agent_role?: string;
    api_integrations?: any;
    memory_context?: any;
    interaction_style?: any;
  }) => {
    if (!user) return null;

    try {
      const { data, error } = await supabase
        .from('agents')
        .insert([{
          name: agentData.name,
          description: agentData.description,
          agent_type: agentData.agent_type,
          status: agentData.status || 'inactive',
          configuration: agentData.configuration || {},
          parent_agent_id: agentData.parent_agent_id,
          agent_role: agentData.agent_role,
          api_integrations: agentData.api_integrations || [],
          memory_context: agentData.memory_context || {},
          interaction_style: agentData.interaction_style || {},
          user_id: user.id,
        }])
        .select()
        .single();

      if (error) throw error;
      
      await fetchAgents(); // Refresh the list
      return data;
    } catch (error) {
      console.error('Error creating agent:', error);
      throw error;
    }
  };

  const updateAgent = async (id: string, updates: { 
    status?: string; 
    configuration?: any; 
    performance_data?: any;
    memory_context?: any;
    api_integrations?: any;
    interaction_style?: any;
  }) => {
    try {
      const { data, error } = await supabase
        .from('agents')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      
      await fetchAgents(); // Refresh the list
      return data;
    } catch (error) {
      console.error('Error updating agent:', error);
      throw error;
    }
  };

  const deleteAgent = async (id: string) => {
    try {
      // First delete any child agents (sub-agents in teams)
      await supabase
        .from('agents')
        .delete()
        .eq('parent_agent_id', id);

      // Then delete the main agent
      const { error } = await supabase
        .from('agents')
        .delete()
        .eq('id', id);

      if (error) throw error;
      
      await fetchAgents(); // Refresh the list
    } catch (error) {
      console.error('Error deleting agent:', error);
      throw error;
    }
  };

  const getAgentTeam = async (parentAgentId: string) => {
    try {
      const { data, error } = await supabase
        .from('agents')
        .select('*')
        .eq('parent_agent_id', parentAgentId)
        .order('team_position');

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching agent team:', error);
      return [];
    }
  };

  const chatWithAgent = async (agentType: string, message: string, context?: string, conversationHistory?: any[]) => {
    try {
      const { data, error } = await supabase.functions.invoke('agent-creation-chat', {
        body: {
          message,
          agentType,
          context,
          conversationHistory,
        },
      });

      if (error) throw error;
      return data.response;
    } catch (error) {
      console.error('Error chatting with agent creation AI:', error);
      throw error;
    }
  };

  const saveConversation = async (sessionId: string, messageType: 'user' | 'assistant' | 'system', content: string, metadata?: any) => {
    if (!user) return;

    try {
      const { error } = await supabase
        .from('agent_conversations')
        .insert({
          user_id: user.id,
          session_id: sessionId,
          message_type: messageType,
          content,
          metadata: metadata || {}
        });

      if (error) throw error;
    } catch (error) {
      console.error('Error saving conversation:', error);
    }
  };

  useEffect(() => {
    fetchAgents();
    fetchTemplates();
  }, [user]);

  return {
    agents,
    templates,
    loading,
    createAgent,
    updateAgent,
    deleteAgent,
    getAgentTeam,
    chatWithAgent,
    saveConversation,
    refetch: fetchAgents,
  };
};