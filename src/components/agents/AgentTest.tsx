import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { 
  Play, 
  Loader2, 
  CheckCircle, 
  XCircle, 
  Clock,
  BarChart3,
  MessageSquare,
  Calendar,
  Mail,
  TrendingUp
} from "lucide-react";

interface AgentTestProps {
  agent: any;
  onTestComplete?: (result: any) => void;
}

const AgentTest = ({ agent, onTestComplete }: AgentTestProps) => {
  const [isRunning, setIsRunning] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [testContext, setTestContext] = useState("{}");
  const [testResult, setTestResult] = useState<any>(null);
  const { toast } = useToast();

  const getTestTemplate = (agentType: string) => {
    switch (agentType) {
      case 'scheduler':
        return {
          input: "Vad ska jag göra idag? Jag har möte kl 14 och behöver handla mat.",
          context: '{"current_time": "2024-01-15T10:00:00Z", "timezone": "Europe/Stockholm"}'
        };
      case 'email_manager':
        return {
          input: "Hej! Jag undrar om vi kan boka ett möte nästa vecka för att diskutera projektet. Mvh Anna",
          context: '{"sender": "anna@example.com", "subject": "Möte nästa vecka"}'
        };
      case 'cryptotrader':
        return {
          input: "Analysera BTC marknaden och ge handelsrekommendation",
          context: '{"portfolio_balance": 10000, "risk_tolerance": "moderate"}'
        };
      case 'reminder_system':
        return {
          input: "Påminn mig att vattna växterna varje onsdag kl 18:00",
          context: '{"user_timezone": "Europe/Stockholm", "current_day": "måndag"}'
        };
      case 'context_manager':
        return {
          input: "Ge mig en översikt av min dag och koordinera mina agenter",
          context: '{"active_projects": ["projekt1", "projekt2"], "upcoming_deadlines": []}'
        };
      default:
        return {
          input: "Hej! Kan du hjälpa mig?",
          context: '{}'
        };
    }
  };

  const loadTemplate = () => {
    const template = getTestTemplate(agent.agent_type);
    setTestInput(template.input);
    setTestContext(template.context);
  };

  const runTest = async () => {
    if (!testInput.trim()) {
      toast({
        title: "Input krävs",
        description: "Ange test-input för agenten.",
        variant: "destructive",
      });
      return;
    }

    setIsRunning(true);
    setTestResult(null);

    try {
      let context = {};
      try {
        context = JSON.parse(testContext);
      } catch {
        context = {};
      }

      const { data, error } = await supabase.functions.invoke('agent-executor', {
        body: {
          agentId: agent.id,
          input: { message: testInput },
          context
        },
      });

      if (error) throw error;

      setTestResult(data);
      onTestComplete?.(data);

      toast({
        title: data.success ? "Test lyckades! ✅" : "Test misslyckades ❌",
        description: data.success 
          ? "Agenten kördes framgångsrikt" 
          : `Fel: ${data.error}`,
        variant: data.success ? "default" : "destructive"
      });

    } catch (error: any) {
      console.error('Test failed:', error);
      const errorResult = {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
      setTestResult(errorResult);
      
      toast({
        title: "Test fel ❌",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsRunning(false);
    }
  };

  const renderResult = (result: any) => {
    if (!result) return null;

    const getResultIcon = () => {
      if (result.success) {
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      }
      return <XCircle className="w-5 h-5 text-red-500" />;
    };

    const getAgentSpecificDisplay = () => {
      if (!result.success || !result.result) return null;

      switch (agent.agent_type) {
        case 'scheduler':
          return (
            <div className="space-y-2">
              <div className="text-sm">
                <strong>Analys:</strong> {result.result.analysis}
              </div>
              {result.result.recommendations?.length > 0 && (
                <div className="text-sm">
                  <strong>Rekommendationer:</strong>
                  <ul className="list-disc list-inside ml-2">
                    {result.result.recommendations.map((rec: string, i: number) => (
                      <li key={i}>{rec}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );

        case 'email_manager':
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant={
                  result.result.priority === 'urgent' ? 'destructive' :
                  result.result.priority === 'high' ? 'default' : 'secondary'
                }>
                  {result.result.priority}
                </Badge>
                <Badge variant="outline">{result.result.category}</Badge>
              </div>
              <div className="text-sm">
                <strong>Föreslaget svar:</strong> {result.result.suggested_response}
              </div>
            </div>
          );

        case 'cryptotrader':
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant={
                  result.result.action === 'buy' ? 'default' :
                  result.result.action === 'sell' ? 'destructive' : 'secondary'
                }>
                  {result.result.action?.toUpperCase()}
                </Badge>
                <Badge variant="outline">Förtroende: {result.result.confidence}%</Badge>
              </div>
              <div className="text-sm">
                <strong>Resonemang:</strong> {result.result.reasoning}
              </div>
              {result.result.market_data && (
                <div className="text-xs text-muted-foreground">
                  Pris: ${result.result.market_data.price?.toFixed(2)} | 
                  Förändring: {result.result.market_data.change_24h?.toFixed(2)}%
                </div>
              )}
            </div>
          );

        case 'reminder_system':
          return (
            <div className="space-y-2">
              <div className="text-sm">
                <strong>Påminnelse:</strong> {result.result.reminder_text}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{result.result.type}</Badge>
                <Badge variant={
                  result.result.priority === 'high' ? 'default' : 'secondary'
                }>
                  {result.result.priority}
                </Badge>
              </div>
            </div>
          );

        case 'context_manager':
          return (
            <div className="space-y-2">
              <div className="text-sm">
                <strong>Samordning:</strong> {result.result.coordination_summary}
              </div>
              {result.result.team_results?.length > 0 && (
                <div className="text-xs">
                  <strong>Team-resultat:</strong> {result.result.team_results.length} agenter körda
                </div>
              )}
            </div>
          );

        default:
          return (
            <div className="text-sm">
              <strong>Svar:</strong> {result.result.response || JSON.stringify(result.result)}
            </div>
          );
      }
    };

    return (
      <Card className="mt-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            {getResultIcon()}
            Test Resultat
            <Badge variant="outline" className="text-xs">
              {result.execution_time}ms
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {result.success ? (
            getAgentSpecificDisplay()
          ) : (
            <div className="text-sm text-red-600">
              <strong>Fel:</strong> {result.error}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="w-5 h-5" />
          Test Agent: {agent.name}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Kör en test för att se hur agenten fungerar
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-sm font-medium">Test Input</label>
          <Textarea
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="Ange vad du vill testa..."
            rows={3}
          />
        </div>

        <div>
          <label className="text-sm font-medium">Kontext (JSON)</label>
          <Textarea
            value={testContext}
            onChange={(e) => setTestContext(e.target.value)}
            placeholder='{"key": "value"}'
            rows={2}
            className="font-mono text-xs"
          />
        </div>

        <div className="flex gap-2">
          <Button
            onClick={runTest}
            disabled={isRunning}
            className="flex-1"
          >
            {isRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Kör Test...
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Kör Test
              </>
            )}
          </Button>
          
          <Button
            onClick={loadTemplate}
            variant="outline"
          >
            Ladda Mall
          </Button>
        </div>

        {renderResult(testResult)}
      </CardContent>
    </Card>
  );
};

export default AgentTest;