import { useState, useEffect, useRef } from "react";
import Navigation from "@/components/layout/Navigation";
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
  Sparkles, 
  Users, 
  Calendar,
  Mail,
  MessageCircle,
  Phone,
  Bell,
  Brain,
  ArrowLeft,
  Check,
  Loader2
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from 'uuid';

interface Message {
  id: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: any;
}

interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  agent_type: string;
  default_configuration: any;
  required_integrations: string[];
  prompt_template: string;
  interaction_style: any;
}

const getAgentIcon = (agentType: string) => {
  switch (agentType) {
    case 'scheduler': return Calendar;
    case 'email_manager': return Mail;
    case 'messenger': return MessageCircle;
    case 'sms_handler': return Phone;
    case 'reminder_system': return Bell;
    case 'context_manager': return Brain;
    default: return Bot;
  }
};

const AgentChat = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId] = useState(() => uuidv4());
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [creationStep, setCreationStep] = useState<'greeting' | 'type_selection' | 'customization' | 'team_setup' | 'completion'>('greeting');
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);
  const [agentConfig, setAgentConfig] = useState<any>({});
  const [isCreating, setIsCreating] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTemplates();
    // Initial greeting
    addMessage('assistant', 'Hej! 👋 Jag hjälper dig att skapa din AI-agent. Vad vill du att din agent ska hjälpa dig med?');
    setCreationStep('type_selection');
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const addMessage = (type: 'user' | 'assistant' | 'system', content: string, metadata?: any) => {
    const message: Message = {
      id: uuidv4(),
      type,
      content,
      timestamp: new Date(),
      metadata
    };
    setMessages(prev => [...prev, message]);
    return message;
  };

  const generateDefaultFlow = (agentType: string) => {
    const defaultFlows = {
      cryptotrader: {
        nodes: [
          {
            id: '1',
            type: 'trigger',
            position: { x: 100, y: 100 },
            data: { label: 'Market Analysis', triggerType: 'schedule' }
          },
          {
            id: '2', 
            type: 'binance',
            position: { x: 300, y: 100 },
            data: { label: 'Get Market Data', action: 'get_price' }
          },
          {
            id: '3',
            type: 'gpt',
            position: { x: 500, y: 100 },
            data: { label: 'AI Trading Analysis', prompt: 'Analyze market and recommend trades' }
          },
          {
            id: '4',
            type: 'condition',
            position: { x: 700, y: 100 },
            data: { label: 'High Confidence?', condition: 'confidence > 80' }
          },
          {
            id: '5',
            type: 'binance',
            position: { x: 500, y: 250 },
            data: { label: 'Execute Trade', action: 'trade' }
          }
        ],
        edges: [
          { id: 'e1-2', source: '1', target: '2' },
          { id: 'e2-3', source: '2', target: '3' },
          { id: 'e3-4', source: '3', target: '4' },
          { id: 'e4-5', source: '4', target: '5' }
        ]
      },
      email_manager: {
        nodes: [
          {
            id: '1',
            type: 'trigger',
            position: { x: 100, y: 100 },
            data: { label: 'New Email', triggerType: 'webhook' }
          },
          {
            id: '2',
            type: 'email',
            position: { x: 300, y: 100 },
            data: { label: 'Read Email', action: 'read' }
          },
          {
            id: '3',
            type: 'gpt',
            position: { x: 500, y: 100 },
            data: { label: 'Analyze & Categorize', prompt: 'Analyze email priority and content' }
          }
        ],
        edges: [
          { id: 'e1-2', source: '1', target: '2' },
          { id: 'e2-3', source: '2', target: '3' }
        ]
      }
    };

    return defaultFlows[agentType as keyof typeof defaultFlows] || {
      nodes: [
        {
          id: '1',
          type: 'trigger',
          position: { x: 250, y: 100 },
          data: { label: 'Start', triggerType: 'manual' }
        },
        {
          id: '2',
          type: 'gpt',
          position: { x: 450, y: 100 },
          data: { label: 'AI Processing', prompt: 'Process user input' }
        }
      ],
      edges: [{ id: 'e1-2', source: '1', target: '2' }]
    };
  };

  const handleTemplateSelection = (template: AgentTemplate) => {
    setSelectedTemplate(template);
    setAgentConfig({
      name: template.name,
      description: template.description,
      agent_type: template.agent_type,
      configuration: template.default_configuration,
      required_integrations: template.required_integrations,
      interaction_style: template.interaction_style
    });
    
    addMessage('user', `Jag vill skapa en ${template.name}`);
    
    setTimeout(() => {
      setIsTyping(true);
      setTimeout(() => {
        setIsTyping(false);
        addMessage('assistant', `Perfekt! En ${template.name} är en utmärkt start. ${template.description}

Ska jag skapa agenten nu?`);
        setCreationStep('team_setup');
      }, 1000);
    }, 500);
  };

  const createAgent = async () => {
    if (!selectedTemplate || !user) return;
    
    setIsCreating(true);
    try {
      // Generate default flow for the agent
      const defaultFlow = generateDefaultFlow(selectedTemplate.agent_type);
      
      const agentData = {
        name: agentConfig.name,
        description: agentConfig.description,
        agent_type: agentConfig.agent_type,
        status: 'inactive',
        configuration: {
          ...agentConfig.configuration,
          prompt_template: selectedTemplate.prompt_template,
          required_integrations: agentConfig.required_integrations,
          nodes: defaultFlow.nodes,
          edges: defaultFlow.edges,
          flowDescription: `Automatiskt genererat flöde för ${agentConfig.name}`
        },
        interaction_style: agentConfig.interaction_style,
        api_integrations: agentConfig.required_integrations || [],
        memory_context: {},
        user_id: user.id
      };

      const { data: agent, error } = await supabase
        .from('agents')
        .insert([agentData])
        .select()
        .single();

      if (error) throw error;

      addMessage('assistant', `🎉 Fantastiskt! Din ${agentConfig.name} har skapats och är redo att användas. 

Agent-ID: ${agent.id}
Status: Inaktiv (aktivera när du är redo)

Vill du:
• Testa agenten direkt
• Konfigurera API-integrations  
• Skapa fler agenter
• Gå till agent-översikten`);
      
      setCreationStep('completion');
      
      toast({
        title: "Agent skapad! ✨",
        description: `${agentConfig.name} har skapats framgångsrikt.`,
      });

    } catch (error) {
      console.error('Error creating agent:', error);
      toast({
        title: "Fel",
        description: "Kunde inte skapa agenten. Försök igen.",
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return;

    const userMessage = addMessage('user', inputValue);
    setInputValue("");
    
    // Handle different conversation flows based on current step
    if (creationStep === 'team_setup') {
      const message = inputValue.toLowerCase();
      
      if (message.includes('ja') || message.includes('skapa')) {
        await createAgent();
      } else {
        addMessage('assistant', 'Okej! Vill du ändra något eller återgå till huvudmenyn?');
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background">
      <Navigation />
      
      <main className="flex-1 flex pt-16">
        {/* Chat Area */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="border-b bg-card/50 p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => navigate("/agents")}
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Tillbaka
              </Button>
              <div className="flex items-center gap-2">
                <Bot className="w-6 h-6 text-primary" />
                <div>
                  <h1 className="font-medium">Agent Creator</h1>
                  <p className="text-sm text-muted-foreground">Skapa AI-agenter med naturlig konversation</p>
                </div>
              </div>
            </div>
            
            <Badge variant="secondary" className="flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              AI-Powered
            </Badge>
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1 p-4">
            <div className="max-w-4xl mx-auto space-y-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[80%] ${
                    message.type === 'user' 
                      ? 'bg-primary text-primary-foreground' 
                      : 'bg-muted'
                  } rounded-lg p-3`}>
                    <p className="whitespace-pre-wrap">{message.content}</p>
                    <p className="text-xs opacity-70 mt-1">
                      {message.timestamp.toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              ))}
              
              {isTyping && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg p-3 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-sm">AI skriver...</span>
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
                placeholder="Skriv ditt meddelande..."
                disabled={isCreating}
                className="flex-1"
              />
              <Button 
                onClick={handleSendMessage}
                disabled={!inputValue.trim() || isCreating}
              >
                {isCreating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Sidebar with Templates */}
        <div className="w-80 border-l bg-card/30 p-4">
          <h2 className="font-medium mb-4 flex items-center gap-2">
            <Users className="w-4 h-4" />
            Agent-mallar
          </h2>
          
          <div className="space-y-3">
            {templates.map((template) => {
              const IconComponent = getAgentIcon(template.agent_type);
              return (
                <Card 
                  key={template.id} 
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    selectedTemplate?.id === template.id ? 'ring-2 ring-primary' : ''
                  }`}
                  onClick={() => handleTemplateSelection(template)}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <IconComponent className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-sm truncate">{template.name}</h3>
                        <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                          {template.description}
                        </p>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {template.required_integrations.slice(0, 2).map((integration) => (
                            <Badge key={integration} variant="secondary" className="text-xs">
                              {integration}
                            </Badge>
                          ))}
                          {template.required_integrations.length > 2 && (
                            <Badge variant="secondary" className="text-xs">
                              +{template.required_integrations.length - 2}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {selectedTemplate?.id === template.id && (
                        <Check className="w-4 h-4 text-primary flex-shrink-0" />
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {creationStep === 'completion' && (
            <div className="mt-6 space-y-2">
              <Button
                onClick={() => navigate("/agents")}
                className="w-full"
                variant="outline"
              >
                Visa Alla Agenter
              </Button>
              <Button
                onClick={() => {
                  setMessages([]);
                  setCreationStep('greeting');
                  setSelectedTemplate(null);
                  addMessage('assistant', 'Hej igen! Vill du skapa en till agent?');
                  setCreationStep('type_selection');
                }}
                className="w-full gradient-primary shadow-primary"
              >
                Skapa Ny Agent
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default AgentChat;