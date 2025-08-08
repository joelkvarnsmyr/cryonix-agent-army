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
}

export const useAgents = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
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
      setAgents(data || []);
    } catch (error) {
      console.error('Error fetching agents:', error);
    } finally {
      setLoading(false);
    }
  };

  const createAgent = async (agentData: { name: string; description: string; agent_type: string; status?: string; configuration?: any }) => {
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

  const updateAgent = async (id: string, updates: { status?: string; configuration?: any; performance_data?: any }) => {
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

  const chatWithAgent = async (agentType: string, message: string, context?: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('ai-chat', {
        body: {
          message,
          agent_type: agentType,
          context,
        },
      });

      if (error) throw error;
      return data.response;
    } catch (error) {
      console.error('Error chatting with agent:', error);
      throw error;
    }
  };

  useEffect(() => {
    fetchAgents();
  }, [user]);

  return {
    agents,
    loading,
    createAgent,
    updateAgent,
    deleteAgent,
    chatWithAgent,
    refetch: fetchAgents,
  };
};