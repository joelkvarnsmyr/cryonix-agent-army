import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const openAIApiKey = Deno.env.get('OPENAI_API_KEY');

const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Agent execution engine
const executeAgent = async (agent: any, input: any, context: any = {}) => {
  console.log(`Executing agent ${agent.name} (${agent.agent_type})`);
  
  try {
    switch (agent.agent_type) {
      case 'scheduler':
        return await executeSchedulerAgent(agent, input, context);
      case 'email_manager':
        return await executeEmailAgent(agent, input, context);
      case 'cryptotrader':
        return await executeCryptoAgent(agent, input, context);
      case 'reminder_system':
        return await executeReminderAgent(agent, input, context);
      case 'context_manager':
        return await executeContextManager(agent, input, context);
      default:
        return await executeGenericAgent(agent, input, context);
    }
  } catch (error) {
    console.error(`Error executing agent ${agent.name}:`, error);
    return {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};

// Scheduler Agent Implementation
const executeSchedulerAgent = async (agent: any, input: any, context: any) => {
  const prompt = `${agent.configuration.prompt_template}

Aktuell tid: ${new Date().toLocaleString('sv-SE')}
Användarens input: ${input.message || input.query}
Kontext: ${JSON.stringify(context)}

Analysera och ge en strukturerad daglig överblick. Svara i JSON-format:
{
  "analysis": "din analys",
  "recommendations": ["rekommendation 1", "rekommendation 2"],
  "schedule_optimizations": ["optimering 1", "optimering 2"],
  "next_actions": ["åtgärd 1", "åtgärd 2"]
}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openAIApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-2025-04-14',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    }),
  });

  const data = await response.json();
  let result;
  
  try {
    result = JSON.parse(data.choices[0].message.content);
  } catch {
    result = {
      analysis: data.choices[0].message.content,
      recommendations: [],
      schedule_optimizations: [],
      next_actions: []
    };
  }

  return {
    success: true,
    result,
    execution_time: Date.now(),
    agent_type: 'scheduler'
  };
};

// Email Agent Implementation  
const executeEmailAgent = async (agent: any, input: any, context: any) => {
  const prompt = `${agent.configuration.prompt_template}

Email att analysera: ${input.email_content || input.message}
Kontext: ${JSON.stringify(context)}

Analysera detta email och svara i JSON-format:
{
  "priority": "low|medium|high|urgent",
  "category": "kategori",
  "suggested_response": "föreslaget svar",
  "action_required": true/false,
  "summary": "sammanfattning",
  "follow_up_needed": true/false
}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openAIApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-2025-04-14',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
    }),
  });

  const data = await response.json();
  let result;
  
  try {
    result = JSON.parse(data.choices[0].message.content);
  } catch {
    result = {
      priority: "medium",
      category: "general",
      suggested_response: data.choices[0].message.content,
      action_required: false,
      summary: "Email processed",
      follow_up_needed: false
    };
  }

  return {
    success: true,
    result,
    execution_time: Date.now(),
    agent_type: 'email_manager'
  };
};

// Crypto Trading Agent Implementation
const executeCryptoAgent = async (agent: any, input: any, context: any) => {
  // Simulate market analysis
  const mockMarketData = {
    symbol: input.symbol || 'BTC/USDT',
    price: 45000 + Math.random() * 10000,
    volume: Math.random() * 1000000,
    change_24h: (Math.random() - 0.5) * 10
  };

  const prompt = `${agent.configuration.prompt_template}

Marknadsdata: ${JSON.stringify(mockMarketData)}
Användarens begäran: ${input.message || input.action}
Risk-nivå: ${agent.configuration.risk_level || 'moderate'}

Analysera marknaden och ge handelsrekommendation i JSON-format:
{
  "action": "buy|sell|hold",
  "confidence": 0-100,
  "risk_score": 0-100,
  "reasoning": "förklaring",
  "suggested_amount": "amount in USD",
  "stop_loss": "price level",
  "take_profit": "price level"
}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openAIApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-2025-04-14',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  });

  const data = await response.json();
  let result;
  
  try {
    result = JSON.parse(data.choices[0].message.content);
  } catch {
    result = {
      action: "hold",
      confidence: 50,
      risk_score: 60,
      reasoning: data.choices[0].message.content,
      suggested_amount: "0",
      stop_loss: "0",
      take_profit: "0"
    };
  }

  return {
    success: true,
    result: { ...result, market_data: mockMarketData },
    execution_time: Date.now(),
    agent_type: 'cryptotrader'
  };
};

// Generic Agent Implementation
const executeGenericAgent = async (agent: any, input: any, context: any) => {
  const prompt = `${agent.configuration.prompt_template || 'Du är en hjälpsam AI-assistent.'}

Användarens input: ${input.message || JSON.stringify(input)}
Kontext: ${JSON.stringify(context)}

Svara som denna agent skulle göra baserat på dess specialitet och konfiguration.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openAIApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-2025-04-14',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    }),
  });

  const data = await response.json();
  
  return {
    success: true,
    result: {
      response: data.choices[0].message.content,
      agent_type: agent.agent_type
    },
    execution_time: Date.now(),
    agent_type: agent.agent_type
  };
};

// Context Manager - coordinates other agents
const executeContextManager = async (agent: any, input: any, context: any) => {
  // Get team members
  const { data: teamAgents } = await supabase
    .from('agents')
    .select('*')
    .eq('parent_agent_id', agent.id)
    .eq('status', 'active');

  const results = [];
  
  // Execute relevant team members based on input
  for (const teamAgent of teamAgents || []) {
    try {
      const result = await executeAgent(teamAgent, input, context);
      results.push({
        agent: teamAgent.name,
        result: result
      });
    } catch (error) {
      console.error(`Error executing team agent ${teamAgent.name}:`, error);
    }
  }

  return {
    success: true,
    result: {
      coordination_summary: `Koordinerade ${results.length} team-agenter`,
      team_results: results,
      recommendations: "Baserat på team-analys..."
    },
    execution_time: Date.now(),
    agent_type: 'context_manager'
  };
};

// Reminder Agent Implementation
const executeReminderAgent = async (agent: any, input: any, context: any) => {
  const prompt = `${agent.configuration.prompt_template}

Påminnelse-begäran: ${input.message}
Aktuell tid: ${new Date().toLocaleString('sv-SE')}

Skapa en smart påminnelse i JSON-format:
{
  "reminder_text": "påminnelse text",
  "scheduled_time": "ISO timestamp",
  "type": "time|location|context",
  "priority": "low|medium|high",
  "recurring": true/false,
  "context_triggers": ["trigger1", "trigger2"]
}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openAIApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-2025-04-14',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
    }),
  });

  const data = await response.json();
  let result;
  
  try {
    result = JSON.parse(data.choices[0].message.content);
  } catch {
    result = {
      reminder_text: data.choices[0].message.content,
      scheduled_time: new Date(Date.now() + 3600000).toISOString(),
      type: "time",
      priority: "medium",
      recurring: false,
      context_triggers: []
    };
  }

  return {
    success: true,
    result,
    execution_time: Date.now(),
    agent_type: 'reminder_system'
  };
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { agentId, input, context } = await req.json();

    // Get agent from database
    const { data: agent, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', agentId)
      .single();

    if (error || !agent) {
      throw new Error('Agent not found');
    }

    // Execute the agent
    const result = await executeAgent(agent, input, context);

    // Update agent's last activity and performance data
    await supabase
      .from('agents')
      .update({
        last_activity: new Date().toISOString(),
        performance_data: {
          ...agent.performance_data,
          last_execution: result,
          execution_count: (agent.performance_data?.execution_count || 0) + 1
        }
      })
      .eq('id', agentId);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error in agent-executor:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});