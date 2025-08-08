import { useState, useEffect } from "react";
import Navigation from "@/components/layout/Navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAgents } from "@/hooks/useAgents";
import { useNavigate } from "react-router-dom";
import { 
  Bot, 
  Plus, 
  MessageCircle, 
  Play,
  Sparkles,
  TrendingUp,
  Activity,
  Calendar,
  Database,
  Mail,
  Settings,
  Users
} from "lucide-react";

const getAgentIcon = (agentType: string) => {
  switch (agentType?.toLowerCase()) {
    case 'scheduler':
      return '📅';
    case 'email_manager':
    case 'email':
      return '📧';
    case 'messenger':
      return '💬';
    case 'sms_handler':
    case 'sms':
      return '📱';
    case 'reminder_system':
    case 'reminder':
      return '⏰';
    case 'context_manager':
      return '🧠';
    case 'trading':
    case 'cryptotrader':
      return '💹';
    case 'assistant':
      return '🤖';
    case 'monitor':
      return '👁️';
    default:
      return '🔧';
  }
};

const Index = () => {
  const { agents, loading } = useAgents();
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    totalAgents: 0,
    activeAgents: 0,
  });

  useEffect(() => {
    if (agents.length > 0) {
      setStats({
        totalAgents: agents.length,
        activeAgents: agents.filter(agent => agent.status === 'active').length
      });
    }
  }, [agents]);

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      
      <main className="pt-20">
        {/* Hero Section */}
        <section className="container mx-auto px-6 py-16 text-center">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-center gap-2 mb-6">
              <Bot className="w-12 h-12 text-primary" />
              <h1 className="text-4xl font-bold">Cryonix</h1>
            </div>
            <h2 className="text-6xl font-bold mb-6 gradient-text">
              Agent Platform
            </h2>
            <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
              Skapa kraftfulla AI-agenter som arbetar självständigt. Automatisera allt från trading till e-posthantering med avancerad AI-teknologi.
            </p>
            <div className="flex items-center justify-center gap-4 mb-8">
              <Badge variant="outline" className="px-4 py-2">
                <Activity className="w-4 h-4 mr-2" />
                {stats.activeAgents} Aktiva
              </Badge>
              <Badge variant="outline" className="px-4 py-2">
                <Bot className="w-4 h-4 mr-2" />
                {stats.totalAgents} Totalt
              </Badge>
            </div>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button 
                size="lg" 
                className="gradient-primary shadow-primary text-lg px-8"
                onClick={() => navigate("/chat")}
              >
                <Plus className="w-5 h-5 mr-2" />
                Ny Agent
              </Button>
              <Button 
                size="lg" 
                variant="outline"
                onClick={() => navigate("/agents")}
              >
                <Settings className="w-5 h-5 mr-2" />
                Hantera Agenter
              </Button>
            </div>
          </div>
        </section>

        {/* Available Agent Templates */}
        <section className="container mx-auto px-6 py-16">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-2xl font-bold mb-2">Tillgängliga Agent Typer</h3>
              <p className="text-muted-foreground">Välj bland fördefinierade mallar eller skapa din egen</p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: '📊',
                title: 'Data Analyst Agent',
                description: 'Avancerad dataanalys och rapportering med AI-insikter',
                tags: ['database', 'analytics_api'],
                type: 'data_analyst'
              },
              {
                icon: '📧',
                title: 'Email Marketing Agent',
                description: 'Automatiserad e-postmarknadsföring med personalisering och A/B-testning',
                tags: ['mailchimp', 'sendgrid'],
                type: 'email_manager'
              },
              {
                icon: '📥',
                title: 'InboxAgent',
                description: 'Hanterar inkommande e-post, sammanfattar, sorterar och föreslår...',
                tags: ['gmail'],
                type: 'email_manager'
              },
              {
                icon: '💬',
                title: 'MessengerAgent',
                description: 'Övervakar Facebook Messenger, extraherar viktiga meddelanden och...',
                tags: ['facebook_graph'],
                type: 'messenger'
              },
              {
                icon: '⏰',
                title: 'ReminderAgent',
                description: 'Skapar, hanterar och triggar påminnelser baserat på naturligt...',
                tags: ['google_tasks', 'notion'],
                type: 'reminder_system'
              },
              {
                icon: '📅',
                title: 'SchedulerAgent',
                description: 'Analyserar kalender, mail och todos för daglig överblick och optimering',
                tags: ['google_calendar', 'gmail'],
                type: 'scheduler'
              },
              {
                icon: '📱',
                title: 'SMSAgent',
                description: 'Övervakar SMS, svarar på enkla meddelanden och flaggar viktiga',
                tags: ['twilio'],
                type: 'sms_handler'
              },
              {
                icon: '📱',
                title: 'Social Media Manager',
                description: 'Automatisk hantering av sociala medier med innehållsskapande och...',
                tags: ['facebook', 'twitter', '+1'],
                type: 'social_media'
              },
              {
                icon: '💹',
                title: 'Crypto Trading Agent',
                description: 'Automatisk kryptovaluta-trading med AI-analys och riskhantering',
                tags: ['binance', 'openai'],
                type: 'cryptotrader'
              }
            ].map((template, index) => (
              <Card key={index} className="glass hover:shadow-lg transition-all group cursor-pointer"
                    onClick={() => navigate(`/chat?template=${template.type}`)}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="text-3xl mb-2">{template.icon}</div>
                  </div>
                  <CardTitle className="text-lg">{template.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-4 line-clamp-3">
                    {template.description}
                  </p>
                  <div className="flex flex-wrap gap-1 mb-4">
                    {template.tags.map((tag, tagIndex) => (
                      <Badge key={tagIndex} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <Button className="w-full group-hover:gradient-primary transition-all">
                    <Plus className="w-4 h-4 mr-2" />
                    Skapa Agent
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Your Agents */}
        {agents.length > 0 && (
          <section className="container mx-auto px-6 py-16">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h3 className="text-2xl font-bold mb-2">Dina Agenter</h3>
                <p className="text-muted-foreground">Översikt över dina aktiva AI-agenter</p>
              </div>
              <Button variant="outline" onClick={() => navigate("/agents")}>
                Visa Alla
              </Button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {agents.slice(0, 6).map((agent) => (
                <Card key={agent.id} className="glass hover:shadow-lg transition-all group">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="text-2xl">{getAgentIcon(agent.agent_type)}</div>
                      <Badge 
                        variant={agent.status === 'active' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {agent.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                      </Badge>
                    </div>
                    <CardTitle className="text-lg">{agent.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                      {agent.description}
                    </p>
                    <div className="flex gap-2">
                      <Button 
                        size="sm" 
                        className="flex-1"
                        onClick={() => navigate(`/chat/${agent.id}`)}
                      >
                        <MessageCircle className="w-3 h-3 mr-1" />
                        Chatta
                      </Button>
                      <Button 
                        size="sm" 
                        variant="outline"
                        onClick={() => navigate(`/builder?edit=${agent.id}`)}
                      >
                        <Settings className="w-3 h-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default Index;
