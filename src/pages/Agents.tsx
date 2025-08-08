import { useState } from "react";
import Navigation from "@/components/layout/Navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAgents } from "@/hooks/useAgents";
import { useToast } from "@/hooks/use-toast";
import { 
  Bot, 
  Search, 
  Filter, 
  Play, 
  Pause, 
  Settings, 
  MessageCircle,
  Trash2,
  Plus,
  MoreVertical,
  Activity,
  Calendar
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const getAgentIcon = (agentType: string) => {
  switch (agentType?.toLowerCase()) {
    case 'trading':
    case 'cryptotrader':
      return '💹';
    case 'email':
      return '📧';
    case 'assistant':
      return '🤖';
    case 'monitor':
      return '👁️';
    default:
      return '🔧';
  }
};

const Agents = () => {
  const { agents, loading, updateAgent, deleteAgent } = useAgents();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentToDelete, setAgentToDelete] = useState<string | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  const filteredAgents = agents.filter(agent => {
    const matchesSearch = agent.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         agent.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === "all" || agent.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleToggleAgent = async (agentId: string, currentStatus: string) => {
    try {
      const newStatus = currentStatus === 'active' ? 'paused' : 'active';
      await updateAgent(agentId, { status: newStatus });
      toast({
        title: "Agent uppdaterad",
        description: `Agent har ${newStatus === 'active' ? 'aktiverats' : 'pausats'}.`,
      });
    } catch (error) {
      toast({
        title: "Fel",
        description: "Kunde inte uppdatera agenten.",
        variant: "destructive",
      });
    }
  };

  const handleDeleteAgent = async (agentId: string) => {
    try {
      await deleteAgent(agentId);
      setAgentToDelete(null);
      toast({
        title: "Agent raderad",
        description: "Agenten har raderats permanent.",
      });
    } catch (error) {
      toast({
        title: "Fel",
        description: "Kunde inte radera agenten.",
        variant: "destructive",
      });
    }
  };

  const handleEditAgent = (agentId: string) => {
    navigate(`/builder?edit=${agentId}`);
  };

  const handleChatWithAgent = (agentId: string) => {
    navigate(`/chat/${agentId}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen">
        <Navigation />
        <div className="pt-20 container mx-auto px-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-muted rounded w-1/4"></div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1,2,3,4,5,6].map(i => (
                <div key={i} className="h-64 bg-muted rounded"></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      
      <main className="pt-20 container mx-auto px-6 pb-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold mb-2">Mina Agenter</h1>
              <p className="text-muted-foreground">Hantera alla dina AI-agenter på ett ställe</p>
            </div>
            <Button 
              onClick={() => navigate("/builder")}
              className="gradient-primary shadow-primary"
            >
              <Plus className="w-4 h-4 mr-2" />
              Ny Agent
            </Button>
          </div>

          {/* Search and Filter */}
          <div className="flex flex-col sm:flex-row gap-4 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
              <Input
                placeholder="Sök agenter..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant={statusFilter === "all" ? "default" : "outline"}
                onClick={() => setStatusFilter("all")}
                size="sm"
              >
                Alla ({agents.length})
              </Button>
              <Button
                variant={statusFilter === "active" ? "default" : "outline"}
                onClick={() => setStatusFilter("active")}
                size="sm"
              >
                Aktiva ({agents.filter(a => a.status === 'active').length})
              </Button>
              <Button
                variant={statusFilter === "paused" ? "default" : "outline"}
                onClick={() => setStatusFilter("paused")}
                size="sm"
              >
                Pausade ({agents.filter(a => a.status === 'paused').length})
              </Button>
            </div>
          </div>
        </div>

        {/* Agents Grid */}
        {filteredAgents.length === 0 ? (
          <Card className="glass text-center py-12">
            <CardContent>
              <Bot className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">
                {searchTerm || statusFilter !== "all" ? "Inga agenter hittades" : "Inga agenter än"}
              </h3>
              <p className="text-muted-foreground mb-4">
                {searchTerm || statusFilter !== "all" 
                  ? "Prova att justera dina sökkriterier" 
                  : "Skapa din första AI-agent för att komma igång"
                }
              </p>
              {!searchTerm && statusFilter === "all" && (
                <Button onClick={() => navigate("/builder")} className="gradient-primary shadow-primary">
                  <Plus className="w-4 h-4 mr-2" />
                  Skapa Din Första Agent
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredAgents.map((agent) => (
              <Card key={agent.id} className="glass hover:shadow-lg transition-all group">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="text-2xl">{getAgentIcon(agent.agent_type)}</div>
                      <div>
                        <CardTitle className="text-lg">{agent.name}</CardTitle>
                        <Badge 
                          variant={agent.status === 'active' ? 'default' : 'secondary'}
                          className="text-xs"
                        >
                          {agent.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                        </Badge>
                      </div>
                    </div>
                    
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEditAgent(agent.id)}>
                          <Settings className="w-4 h-4 mr-2" />
                          Redigera
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleChatWithAgent(agent.id)}>
                          <MessageCircle className="w-4 h-4 mr-2" />
                          Chatta
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem 
                          onClick={() => setAgentToDelete(agent.id)}
                          className="text-destructive"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Radera
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardHeader>
                
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {agent.description || "Ingen beskrivning tillgänglig"}
                  </p>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Typ</span>
                      <span className="capitalize">{agent.agent_type}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Senaste aktivitet</span>
                      <span>{agent.last_activity ? new Date(agent.last_activity).toLocaleDateString() : 'Aldrig'}</span>
                    </div>
                  </div>
                  
                  <div className="flex gap-2 pt-2">
                    <Button
                      variant={agent.status === 'active' ? 'secondary' : 'default'}
                      size="sm"
                      className="flex-1"
                      onClick={() => handleToggleAgent(agent.id, agent.status)}
                    >
                      {agent.status === 'active' ? (
                        <>
                          <Pause className="w-3 h-3 mr-1" />
                          Pausa
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3 mr-1" />
                          Starta
                        </>
                      )}
                    </Button>
                    
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleChatWithAgent(agent.id)}
                    >
                      <MessageCircle className="w-3 h-3" />
                    </Button>
                    
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEditAgent(agent.id)}
                    >
                      <Settings className="w-3 h-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={!!agentToDelete} onOpenChange={() => setAgentToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Radera Agent</AlertDialogTitle>
              <AlertDialogDescription>
                Är du säker på att du vill radera denna agent? Denna åtgärd kan inte ångras.
                All konfiguration och historik kommer att försvinna permanent.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Avbryt</AlertDialogCancel>
              <AlertDialogAction 
                onClick={() => agentToDelete && handleDeleteAgent(agentToDelete)}
                className="bg-destructive hover:bg-destructive/90"
              >
                Radera
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </main>
    </div>
  );
};

export default Agents;