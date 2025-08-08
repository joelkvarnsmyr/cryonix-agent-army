import { useState, useEffect } from "react";
import Navigation from "@/components/layout/Navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAgents } from "@/hooks/useAgents";
import { 
  Bot, 
  TrendingUp, 
  Activity, 
  AlertCircle, 
  DollarSign,
  Users,
  Zap,
  BarChart3,
  Calendar,
  Play,
  Pause,
  Settings
} from "lucide-react";
import { useNavigate } from "react-router-dom";

const Dashboard = () => {
  const { agents, loading } = useAgents();
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    totalAgents: 0,
    activeAgents: 0,
    totalProfit: 2485.50,
    todayProfit: 125.80,
    successRate: 94.2,
    totalTrades: 1247
  });

  useEffect(() => {
    if (agents.length > 0) {
      setStats(prev => ({
        ...prev,
        totalAgents: agents.length,
        activeAgents: agents.filter(agent => agent.status === 'active').length
      }));
    }
  }, [agents]);

  const recentActivity = [
    { id: 1, agent: "Cryptotrader", action: "Bought BTC", time: "2 min ago", profit: "+$45.20" },
    { id: 2, agent: "Email Assistant", action: "Sent 12 replies", time: "5 min ago", profit: null },
    { id: 3, agent: "Market Analyzer", action: "Risk alert", time: "10 min ago", profit: null },
    { id: 4, agent: "DCA Bot", action: "Sold ETH", time: "15 min ago", profit: "+$78.90" },
  ];

  if (loading) {
    return (
      <div className="min-h-screen">
        <Navigation />
        <div className="pt-20 container mx-auto px-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-muted rounded w-1/4"></div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {[1,2,3,4].map(i => (
                <div key={i} className="h-32 bg-muted rounded"></div>
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
          <h1 className="text-3xl font-bold mb-2">Dashboard</h1>
          <p className="text-muted-foreground">Översikt över dina AI-agenter och prestanda</p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <Card className="glass">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Totala Agenter</CardTitle>
              <Bot className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalAgents}</div>
              <p className="text-xs text-muted-foreground">
                <span className="text-green-500">{stats.activeAgents} aktiva</span>
              </p>
            </CardContent>
          </Card>

          <Card className="glass">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Dagens Vinst</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">+${stats.todayProfit}</div>
              <p className="text-xs text-muted-foreground">
                +12.4% från igår
              </p>
            </CardContent>
          </Card>

          <Card className="glass">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Framgångsgrad</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.successRate}%</div>
              <p className="text-xs text-muted-foreground">
                Av {stats.totalTrades} trades
              </p>
            </CardContent>
          </Card>

          <Card className="glass">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Vinst</CardTitle>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${stats.totalProfit}</div>
              <p className="text-xs text-muted-foreground">
                Sedan start
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Recent Activity */}
          <Card className="lg:col-span-2 glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Senaste Aktivitet
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {recentActivity.map((activity) => (
                  <div key={activity.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                        <Bot className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">{activity.agent}</p>
                        <p className="text-xs text-muted-foreground">{activity.action}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">{activity.time}</p>
                      {activity.profit && (
                        <p className="text-sm font-medium text-green-500">{activity.profit}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Snabbåtgärder
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button 
                className="w-full justify-start" 
                variant="outline"
                onClick={() => navigate("/chat")}
              >
                <Bot className="w-4 h-4 mr-2" />
                Skapa Ny Agent
              </Button>
              <Button 
                className="w-full justify-start" 
                variant="outline"
                onClick={() => navigate("/agents")}
              >
                <Settings className="w-4 h-4 mr-2" />
                Hantera Agenter
              </Button>
              <Button 
                className="w-full justify-start" 
                variant="outline"
                onClick={() => navigate("/marketplace")}
              >
                <Users className="w-4 h-4 mr-2" />
                Utforska Marketplace
              </Button>
              <Button 
                className="w-full justify-start" 
                variant="outline"
              >
                <BarChart3 className="w-4 h-4 mr-2" />
                Visa Analytics
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Active Agents Preview */}
        {agents.length > 0 && (
          <Card className="mt-6 glass">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Bot className="h-5 w-5" />
                  Aktiva Agenter
                </CardTitle>
                <Button variant="outline" size="sm" onClick={() => navigate("/agents")}>
                  Visa Alla
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {agents.slice(0, 6).map((agent) => (
                  <div key={agent.id} className="p-4 rounded-lg border bg-card/50 hover:bg-card/80 transition-all">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="font-medium">{agent.name}</h3>
                      <Badge 
                        variant={agent.status === 'active' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {agent.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">
                      {agent.description}
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {agent.agent_type}
                      </span>
                      <Button size="sm" variant="ghost">
                        <Settings className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
};

export default Dashboard;