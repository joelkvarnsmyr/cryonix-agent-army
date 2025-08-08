import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bot, TrendingUp, Mail, Calendar, FileText, Mic, Play, Pause, Settings } from "lucide-react";

const agents = [
  {
    id: 1,
    name: "Cryonix Trader",
    description: "Automatiserad kryptohandel med riskhantering",
    status: "active",
    icon: TrendingUp,
    performance: "+12.4%",
    trades: 47,
    color: "success"
  },
  {
    id: 2,
    name: "InboxTamer",
    description: "AI-driven e-posthantering och svar",
    status: "active",
    icon: Mail,
    performance: "234 emails",
    trades: 0,
    color: "primary"
  },
  {
    id: 3,
    name: "CalGenius",
    description: "Intelligent kalenderplanering och schemaläggning",
    status: "paused",
    icon: Calendar,
    performance: "15 meetings",
    trades: 0,
    color: "warning"
  },
  {
    id: 4,
    name: "DocuBot",
    description: "Dokumentanalys och sammanfattning",
    status: "active",
    icon: FileText,
    performance: "8 documents",
    trades: 0,
    color: "accent"
  },
  {
    id: 5,
    name: "VoiceAgent",
    description: "Mötestranskription och anteckningar",
    status: "inactive",
    icon: Mic,
    performance: "3h recorded",
    trades: 0,
    color: "muted"
  },
  {
    id: 6,
    name: "ResumeBuilder AI",
    description: "Automatisk CV- och brevgenerering",
    status: "active",
    icon: Bot,
    performance: "2 documents",
    trades: 0,
    color: "secondary"
  }
];

const AgentGrid = () => {
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

  return (
    <section className="py-16">
      <div className="container mx-auto px-6">
        <div className="mb-8">
          <h2 className="text-3xl font-bold mb-4">Dina AI-Agenter</h2>
          <p className="text-muted-foreground">Hantera och övervaka alla dina autonoma assistenter</p>
        </div>

        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
          {agents.map((agent) => {
            const IconComponent = agent.icon;
            
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
                      <span className="text-sm text-muted-foreground">Performance</span>
                      <span className="font-semibold">{agent.performance}</span>
                    </div>
                    
                    {agent.trades > 0 && (
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">Trades</span>
                        <span className="font-semibold">{agent.trades}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 mt-6">
                    <Button 
                      size="sm" 
                      variant={agent.status === "active" ? "outline" : "default"}
                      className="flex-1"
                    >
                      {agent.status === "active" ? (
                        <><Pause className="w-4 h-4 mr-2" />Pausa</>
                      ) : (
                        <><Play className="w-4 h-4 mr-2" />Starta</>
                      )}
                    </Button>
                    <Button size="sm" variant="ghost">
                      Detaljer
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default AgentGrid;