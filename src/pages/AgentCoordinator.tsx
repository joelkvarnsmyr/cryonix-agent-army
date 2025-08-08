import { useState, useEffect, useRef } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { 
  Bot, 
  Send, 
  Brain,
  Mail,
  Calendar,
  MessageCircle,
  Phone,
  Bell,
  Users,
  Loader2,
  Play,
  Square,
  Pause,
  CheckCircle,
  AlertCircle,
  Clock
} from "lucide-react";
import { v4 as uuidv4 } from 'uuid';

interface Message {
  id: string;
  type: 'user' | 'assistant' | 'agent' | 'system';
  content: string;
  timestamp: Date;
  agentType?: string;
  agentId?: string;
  metadata?: any;
  isThinking?: boolean;
  actionable?: boolean;
}

interface Agent {
  id: string;
  name: string;
  agent_type: string;
  status: 'active' | 'inactive' | 'thinking' | 'working';
  description: string;
  last_activity?: string;
}

const getAgentIcon = (agentType: string) => {
  switch (agentType) {
    case 'coordinator': return Brain;
    case 'mail': return Mail;
    case 'calendar': return Calendar;
    case 'messenger': return MessageCircle;
    case 'phone': return Phone;
    case 'reminder': return Bell;
    default: return Bot;
  }
};

const AgentCoordinator = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionId] = useState(() => uuidv4());
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessionMemory, setSessionMemory] = useState<any>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initializeCoordinator();
    fetchAgents();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const initializeCoordinator = () => {
    addMessage('system', 'LLMCoreAgent Coordinator startar...');
    setTimeout(() => {
      addMessage('assistant', 'Hej! 👋 Jag är din AI Coordinator. Jag koordinerar alla dina agenter och hjälper dig med dagliga uppgifter.\n\nDu kan säga saker som:\n• "Kolla min e-post"\n• "Boka tid med John nästa vecka"\n• "Påminn mig om mötet imorgon"\n• "Vad har jag för möten idag?"');
    }, 1000);
  };

  const fetchAgents = async () => {
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
      console.error('Error fetching agents:', error);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const addMessage = (type: Message['type'], content: string, options?: Partial<Message>) => {
    const message: Message = {
      id: uuidv4(),
      type,
      content,
      timestamp: new Date(),
      ...options
    };
    setMessages(prev => [...prev, message]);
    return message;
  };

  const simulateAgentThinking = (agentType: string, task: string) => {
    return addMessage('agent', `🧠 ${agentType} analyserar: "${task}"`, {
      agentType,
      isThinking: true
    });
  };

  const processWithLLMCore = async (userInput: string) => {
    setIsProcessing(true);
    
    try {
      // Simulate LLMCoreAgent processing
      addMessage('system', 'LLMCoreAgent analyserar din begäran...');
      
      // Simulate thinking delay
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Analyze intent and determine which agents to involve
      const intent = analyzeIntent(userInput);
      
      addMessage('assistant', `🎯 Intention identifierad: ${intent.description}\nDelegerar till: ${intent.agents.join(', ')}`);
      
      // Simulate agent coordination
      for (const agentType of intent.agents) {
        await new Promise(resolve => setTimeout(resolve, 800));
        simulateAgentThinking(agentType, intent.task);
        
        await new Promise(resolve => setTimeout(resolve, 1200));
        addMessage('agent', generateAgentResponse(agentType, intent.task), {
          agentType,
          actionable: true
        });
      }
      
      // Final coordinator response
      await new Promise(resolve => setTimeout(resolve, 500));
      addMessage('assistant', intent.coordinatorResponse, {
        actionable: true
      });
      
    } catch (error) {
      console.error('Error processing with LLMCore:', error);
      addMessage('system', 'Fel vid bearbetning. Försök igen.');
    } finally {
      setIsProcessing(false);
    }
  };

  const analyzeIntent = (input: string): {
    description: string;
    agents: string[];
    task: string;
    coordinatorResponse: string;
  } => {
    const lowerInput = input.toLowerCase();
    
    if (lowerInput.includes('e-post') || lowerInput.includes('mail') || lowerInput.includes('mejl')) {
      return {
        description: 'E-posthantering',
        agents: ['MailAgent'],
        task: 'kontrollera och kategorisera e-post',
        coordinatorResponse: '📧 MailAgent har kontrollerat din inkorg. Du har 3 viktiga mejl som behöver uppmärksamhet:\n\n• Mötesinbjudan från Sara (idag 14:00)\n• Projektuppdatering från teamet\n• Faktura som förfaller imorgon\n\nVill du att jag hjälper dig svara på något av dessa?'
      };
    }
    
    if (lowerInput.includes('kalender') || lowerInput.includes('möte') || lowerInput.includes('boka')) {
      return {
        description: 'Kalenderhantering',
        agents: ['CalendarAgent'],
        task: 'kontrollera schema och föreslå tider',
        coordinatorResponse: '📅 CalendarAgent har kollat ditt schema. Du har:\n\n• Idag: Teammöte 14:00-15:00\n• Imorgon: Presentation 10:00-11:30\n• Ledig tid: Idag 16:00-17:00, Imorgon 13:00-16:00\n\nVill du boka något specifikt?'
      };
    }
    
    if (lowerInput.includes('påminnelse') || lowerInput.includes('påminn')) {
      return {
        description: 'Påminnelsesystem',
        agents: ['ReminderAgent'],
        task: 'skapa smart påminnelse',
        coordinatorResponse: '⏰ ReminderAgent är redo att skapa din påminnelse. Vad vill du bli påmind om och när?'
      };
    }
    
    // Complex tasks requiring multiple agents
    if (lowerInput.includes('idag') || lowerInput.includes('översikt')) {
      return {
        description: 'Daglig översikt',
        agents: ['MailAgent', 'CalendarAgent', 'ReminderAgent'],
        task: 'sammanställa daglig översikt',
        coordinatorResponse: '📊 **Din dagliga översikt:**\n\n📧 **E-post:** 3 viktiga mejl väntar\n📅 **Kalender:** Teammöte 14:00, presentation förberedd\n⏰ **Påminnelser:** Faktura förfaller imorgon\n🎯 **Prioritet:** Svara på Saras mötesinbjudan\n\nVill du att jag hanterar något av detta?'
      };
    }
    
    return {
      description: 'Allmän förfrågan',
      agents: ['LLMCoreAgent'],
      task: 'bearbeta förfrågan',
      coordinatorResponse: 'Jag har bearbetat din förfrågan. Vad mer kan jag hjälpa dig med idag?'
    };
  };

  const generateAgentResponse = (agentType: string, task: string): string => {
    switch (agentType) {
      case 'MailAgent':
        return '✅ E-post analyserad. Hittade 12 meddelanden, 3 prioriterade som viktiga.';
      case 'CalendarAgent':
        return '✅ Schema kontrollerat. Identifierade konflikter och lediga tider.';
      case 'ReminderAgent':
        return '✅ Påminnelsekontext analyserad. Optimal tidpunkt beräknad.';
      default:
        return '✅ Uppgift slutförd.';
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isProcessing) return;

    const userMessage = addMessage('user', inputValue);
    const currentInput = inputValue;
    setInputValue("");
    
    // Update session memory
    setSessionMemory(prev => ({
      ...prev,
      lastUserInput: currentInput,
      messageCount: (prev.messageCount || 0) + 1,
      lastActivity: new Date().toISOString()
    }));
    
    await processWithLLMCore(currentInput);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const executeAction = (action: string) => {
    addMessage('system', `Utför: ${action}`);
    toast({
      title: "Åtgärd utförd",
      description: action,
    });
  };

  return (
    <div className="h-screen flex flex-col bg-background">
      
      <main className="flex-1 flex pt-0">
        {/* Chat Area */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="border-b bg-card/50 p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Brain className="w-6 h-6 text-primary" />
                <div>
                  <h1 className="font-medium">LLMCoreAgent Coordinator</h1>
                  <p className="text-sm text-muted-foreground">AI-driven agent orchestration</p>
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />
                {agents.filter(a => a.status === 'active').length} Aktiva
              </Badge>
              <Badge variant="outline" className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Session: {sessionId.slice(0, 8)}
              </Badge>
            </div>
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1 p-4">
            <div className="max-w-4xl mx-auto space-y-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[85%] rounded-lg p-3 ${
                    message.type === 'user' 
                      ? 'bg-primary text-primary-foreground' 
                      : message.type === 'agent'
                      ? 'bg-accent/20 border border-accent/30'
                      : message.type === 'system'
                      ? 'bg-muted/50 text-muted-foreground text-sm'
                      : 'bg-muted'
                  }`}>
                    {message.agentType && (
                      <div className="flex items-center gap-2 mb-2 text-xs opacity-70">
                        {(() => {
                          const IconComponent = getAgentIcon(message.agentType);
                          return <IconComponent className="w-3 h-3" />;
                        })()}
                        {message.agentType}
                        {message.isThinking && <Loader2 className="w-3 h-3 animate-spin" />}
                      </div>
                    )}
                    
                    <p className="whitespace-pre-wrap">{message.content}</p>
                    
                    {message.actionable && message.type === 'assistant' && (
                      <div className="flex flex-wrap gap-2 mt-3 pt-2 border-t border-current/20">
                        <Button size="sm" variant="secondary" onClick={() => executeAction("Svara på e-post")}>
                          Svara på e-post
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => executeAction("Boka tid")}>
                          Boka tid
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => executeAction("Skapa påminnelse")}>
                          Skapa påminnelse
                        </Button>
                      </div>
                    )}
                    
                    <p className="text-xs opacity-50 mt-2">
                      {message.timestamp.toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              ))}
              
              {isProcessing && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg p-3 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-sm">LLMCoreAgent arbetar...</span>
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {/* Input Area */}
          <div className="border-t bg-card/50 p-4">
            <div className="max-w-4xl mx-auto flex gap-2">
              <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Vad kan jag hjälpa dig med idag? (t.ex. 'Kolla min e-post', 'Boka möte')"
                disabled={isProcessing}
                className="flex-1"
              />
              <Button 
                onClick={handleSendMessage}
                disabled={!inputValue.trim() || isProcessing}
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Agent Status Sidebar */}
        <div className="w-80 border-l bg-card/30 p-4">
          <h2 className="font-medium mb-4 flex items-center gap-2">
            <Users className="w-4 h-4" />
            Agent Status
          </h2>
          
          <div className="space-y-3">
            {/* LLMCoreAgent Status */}
            <Card className="glass">
              <CardContent className="p-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <Brain className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-medium text-sm">LLMCoreAgent</h3>
                    <p className="text-xs text-muted-foreground">Central coordinator</p>
                  </div>
                  <Badge variant={isProcessing ? "default" : "secondary"} className="text-xs">
                    {isProcessing ? "Working" : "Ready"}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* Available Agents */}
            {[
              { name: "MailAgent", type: "mail", status: "active", description: "E-post hantering" },
              { name: "CalendarAgent", type: "calendar", status: "active", description: "Schema koordination" },
              { name: "ReminderAgent", type: "reminder", status: "active", description: "Smart påminnelser" },
              { name: "ActionAgent", type: "phone", status: "inactive", description: "Externa åtgärder" }
            ].map((agent) => {
              const IconComponent = getAgentIcon(agent.type);
              return (
                <Card key={agent.name} className="glass">
                  <CardContent className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center">
                        <IconComponent className="w-4 h-4 text-accent" />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-medium text-sm">{agent.name}</h3>
                        <p className="text-xs text-muted-foreground">{agent.description}</p>
                      </div>
                      <Badge 
                        variant={agent.status === "active" ? "default" : "secondary"} 
                        className="text-xs"
                      >
                        {agent.status === "active" ? "Aktiv" : "Inaktiv"}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Session Memory */}
          <div className="mt-6">
            <h3 className="text-sm font-medium mb-2">Session Memory</h3>
            <Card className="glass">
              <CardContent className="p-3">
                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Meddelanden:</span>
                    <span className="ml-2">{sessionMemory.messageCount || 0}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Senaste aktivitet:</span>
                    <span className="ml-2">
                      {sessionMemory.lastActivity 
                        ? new Date(sessionMemory.lastActivity).toLocaleTimeString()
                        : 'Ingen aktivitet'
                      }
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AgentCoordinator;