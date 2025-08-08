import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { Bot, TrendingUp, Mail, Calendar, FileText, Mic, Play, Pause, Settings, Heart, Dumbbell, Brain, DollarSign, BookOpen, Activity, Plus, MessageSquare } from "lucide-react";
import { useAgents } from "@/hooks/useAgents";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const getAgentIcon = (agentType: string) => {
  const icons = {
    'cryonix-trader': TrendingUp,
    'life-coach': Heart,
    'fitness-coach': Dumbbell,
    'mindfulness-guide': Brain,
    'finance-advisor': DollarSign,
    'learning-assistant': BookOpen,
    'inbox-tamer': Mail,
    'health-monitor': Activity,
    'cal-genius': Calendar,
    'docu-bot': FileText,
    'voice-agent': Mic,
    'resume-builder': Bot,
  };
  return icons[agentType as keyof typeof icons] || Bot;
};

const AgentGrid = () => {
  const { agents, loading, createAgent, updateAgent, chatWithAgent } = useAgents();
  const { toast } = useToast();
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<any>(null);
  const [chatMessage, setChatMessage] = useState("");
  const [chatResponse, setChatResponse] = useState("");
  const [newAgent, setNewAgent] = useState({
    name: "",
    description: "",
    agent_type: "",
  });
  const getStatusColor = (status: string) => {
    switch (status) {
      case "active": return "success";
      case "paused": return "warning";
      case "inactive": return "secondary";
      default: return "secondary";
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case "active": return "Aktiv";
      case "paused": return "Pausad";
      case "inactive": return "Inaktiv";
      default: return "Okänd";
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createAgent(newAgent);
      setNewAgentOpen(false);
      setNewAgent({ name: "", description: "", agent_type: "" });
      toast({
        title: "Agent skapad!",
        description: `${newAgent.name} har lagts till i din agent-portfolio.`,
      });
    } catch (error) {
      toast({
        title: "Fel vid skapande",
        description: "Kunde inte skapa agenten. Försök igen.",
        variant: "destructive",
      });
    }
  };

  const handleToggleAgent = async (agent: any) => {
    const newStatus = agent.status === 'active' ? 'paused' : 'active';
    try {
      await updateAgent(agent.id, { status: newStatus });
      toast({
        title: newStatus === 'active' ? "Agent aktiverad" : "Agent pausad",
        description: `${agent.name} är nu ${newStatus === 'active' ? 'aktiv' : 'pausad'}.`,
      });
    } catch (error) {
      toast({
        title: "Fel",
        description: "Kunde inte ändra agent-status.",
        variant: "destructive",
      });
    }
  };

  const handleChatWithAgent = async () => {
    if (!selectedAgent || !chatMessage.trim()) return;
    
    try {
      const response = await chatWithAgent(selectedAgent.agent_type, chatMessage);
      setChatResponse(response);
      setChatMessage("");
    } catch (error) {
      toast({
        title: "Fel",
        description: "Kunde inte kommunicera med agenten. Kontrollera att OpenAI API-nyckeln är konfigurerad.",
        variant: "destructive",
      });
    }
  };

  if (loading) {
    return (
      <section className="py-16">
        <div className="container mx-auto px-6">
          <div className="text-center">Laddar agenter...</div>
        </div>
      </section>
    );
  }

  return (
    <section className="py-16">
      <div className="container mx-auto px-6">
        <div className="mb-8 flex justify-between items-center">
          <div>
            <h2 className="text-3xl font-bold mb-4">Dina AI-Agenter</h2>
            <p className="text-muted-foreground">Hantera och övervaka alla dina autonoma assistenter</p>
          </div>
          <Dialog open={newAgentOpen} onOpenChange={setNewAgentOpen}>
            <DialogTrigger asChild>
              <Button className="gradient-primary shadow-primary">
                <Plus className="w-4 h-4 mr-2" />
                Ny Agent
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Skapa ny AI-Agent</DialogTitle>
                <DialogDescription>
                  Skapa en skräddarsydd AI-agent för dina behov
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateAgent} className="space-y-4">
                <div>
                  <Label htmlFor="agent-name">Namn</Label>
                  <Input
                    id="agent-name"
                    value={newAgent.name}
                    onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
                    placeholder="T.ex. Min Trading Bot"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="agent-description">Beskrivning</Label>
                  <Textarea
                    id="agent-description"
                    value={newAgent.description}
                    onChange={(e) => setNewAgent({ ...newAgent, description: e.target.value })}
                    placeholder="Vad ska din agent göra?"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="agent-type">Agent-typ</Label>
                  <Input
                    id="agent-type"
                    value={newAgent.agent_type}
                    onChange={(e) => setNewAgent({ ...newAgent, agent_type: e.target.value })}
                    placeholder="T.ex. cryonix-trader, life-coach"
                    required
                  />
                </div>
                <Button type="submit" className="w-full">
                  Skapa Agent
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {agents.length === 0 ? (
          <div className="text-center py-12">
            <Bot className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold mb-2">Inga agenter än</h3>
            <p className="text-muted-foreground mb-6">Skapa din första AI-agent för att komma igång</p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
            {agents.map((agent) => {
              const IconComponent = getAgentIcon(agent.agent_type);
            
            return (
              <Card key={agent.id} className="group glass hover:shadow-elevated transition-smooth">
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <IconComponent className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">{agent.name}</CardTitle>
                        <Badge variant={getStatusColor(agent.status) as any} className="mt-1">
                          {getStatusText(agent.status)}
                        </Badge>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm">
                      <Settings className="w-4 h-4" />
                    </Button>
                  </div>
                </CardHeader>

                <CardContent>
                  <p className="text-muted-foreground mb-4 text-sm">{agent.description}</p>
                  
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">Status</span>
                      <span className="font-semibold">{getStatusText(agent.status)}</span>
                    </div>
                    
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">Typ</span>
                      <span className="font-semibold">{agent.agent_type}</span>
                    </div>
                  </div>

                  <div className="flex gap-2 mt-6">
                    <Button 
                      size="sm" 
                      variant={agent.status === "active" ? "outline" : "default"}
                      className="flex-1"
                      onClick={() => handleToggleAgent(agent)}
                    >
                      {agent.status === "active" ? (
                        <><Pause className="w-4 h-4 mr-2" />Pausa</>
                      ) : (
                        <><Play className="w-4 h-4 mr-2" />Starta</>
                      )}
                    </Button>
                    <Button 
                      size="sm" 
                      variant="ghost"
                      onClick={() => {
                        setSelectedAgent(agent);
                        setChatOpen(true);
                      }}
                    >
                      <MessageSquare className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
              );
            })}
          </div>
        )}

        {/* Chat Dialog */}
        <Dialog open={chatOpen} onOpenChange={setChatOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Chatta med {selectedAgent?.name}</DialogTitle>
              <DialogDescription>
                Kommunicera direkt med din AI-agent
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {chatResponse && (
                <div className="p-4 bg-muted rounded-lg">
                  <h4 className="font-semibold mb-2">AI-svar:</h4>
                  <p className="text-sm">{chatResponse}</p>
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={chatMessage}
                  onChange={(e) => setChatMessage(e.target.value)}
                  placeholder="Skriv ditt meddelande..."
                  className="flex-1"
                  onKeyPress={(e) => e.key === 'Enter' && handleChatWithAgent()}
                />
                <Button onClick={handleChatWithAgent}>
                  Skicka
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </section>
  );
};

export default AgentGrid;