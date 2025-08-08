import { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { TrendingUp, Settings, Play, Pause, Activity } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

interface BinanceNodeData {
  label: string;
  action?: 'autonomous_trading' | 'get_price' | 'get_balance';
  symbols?: string[];
  isRunning?: boolean;
}

const BinanceNode = memo(({ data }: { data: BinanceNodeData }) => {
  const [configOpen, setConfigOpen] = useState(false);
  const [symbols, setSymbols] = useState(data.symbols?.join(',') || 'BTCUSDT,ETHUSDT');
  const [interval, setInterval] = useState('60');
  const [isRunning, setIsRunning] = useState(data.isRunning || false);
  const { toast } = useToast();

  const getActionText = () => {
    switch (data.action) {
      case 'autonomous_trading': return 'Autonom Trading';
      case 'get_price': return 'Hämta Pris';
      case 'get_balance': return 'Kontrollera Saldo';
      default: return 'Trading Bot';
    }
  };

  const getActionColor = () => {
    switch (data.action) {
      case 'autonomous_trading': return isRunning ? 'text-green-600' : 'text-orange-600';
      case 'get_price': return 'text-blue-600';
      case 'get_balance': return 'text-purple-600';
      default: return 'text-yellow-600';
    }
  };

  const startAutonomousTrading = async () => {
    try {
      setIsRunning(true);
      
      const { data: result, error } = await supabase.functions.invoke('autonomous-trading-loop', {
        body: {
          botId: 'demo-bot-123',
          symbols: symbols.split(',').map(s => s.trim()),
          interval: parseInt(interval) * 1000
        }
      });

      if (error) throw error;

      toast({
        title: "Trading Bot Startad! 🚀",
        description: `Bot kör nu autonomous trading för ${symbols}`,
      });

      console.log('Trading cycle result:', result);

    } catch (error: any) {
      setIsRunning(false);
      toast({
        title: "Fel vid start",
        description: error.message || "Kunde inte starta trading bot",
        variant: "destructive",
      });
    }
  };

  const stopTrading = () => {
    setIsRunning(false);
    toast({
      title: "Trading Bot Stoppad",
      description: "Autonomous trading har stoppats",
    });
  };

  const testDataFetch = async () => {
    try {
      const { data: result, error } = await supabase.functions.invoke('data-fetch-service', {
        body: {
          symbols: symbols.split(',').map(s => s.trim()),
          timeframe: '1m',
          newsKeywords: ['bitcoin', 'crypto']
        }
      });

      if (error) throw error;

      toast({
        title: "Marknadsdata Hämtad! 📊",
        description: `Data för ${result.marketData.successful.length} symboler`,
      });

      console.log('Market data:', result);

    } catch (error: any) {
      toast({
        title: "Fel vid datahämtning",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="bg-white border-2 border-yellow-200 rounded-lg p-4 min-w-[280px] shadow-md">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-yellow-500 flex items-center justify-center relative">
            <TrendingUp className="w-4 h-4 text-white" />
            {isRunning && (
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full animate-pulse" />
            )}
          </div>
          <div>
            <div className="font-semibold text-sm">{data.label}</div>
            <Badge variant="secondary" className="text-xs">
              Cryonix Trader
            </Badge>
          </div>
        </div>
        <div className="flex gap-1">
          <Dialog open={configOpen} onOpenChange={setConfigOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm">
                <Settings className="w-3 h-3" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Trading Bot Konfiguration</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="symbols">Trading Symboler</Label>
                  <Input
                    id="symbols"
                    value={symbols}
                    onChange={(e) => setSymbols(e.target.value)}
                    placeholder="BTCUSDT,ETHUSDT,ADAUSDT"
                  />
                </div>
                <div>
                  <Label htmlFor="interval">Cykel Intervall (sekunder)</Label>
                  <Select value={interval} onValueChange={setInterval}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">30 sekunder</SelectItem>
                      <SelectItem value="60">1 minut</SelectItem>
                      <SelectItem value="300">5 minuter</SelectItem>
                      <SelectItem value="900">15 minuter</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex gap-2">
                  <Button onClick={testDataFetch} variant="outline" className="flex-1">
                    Testa Data
                  </Button>
                  <Button onClick={() => setConfigOpen(false)} className="flex-1">
                    Spara
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      
      <div className="space-y-2 mb-3">
        <div className={`text-xs font-medium ${getActionColor()}`}>
          {getActionText()} {isRunning && <Activity className="w-3 h-3 inline ml-1" />}
        </div>
        <div className="text-xs">
          <span className="font-medium">Symboler:</span> {symbols}
        </div>
        <div className="text-xs">
          <span className="font-medium">Intervall:</span> {interval}s
        </div>
        {isRunning && (
          <div className="text-xs text-green-600 font-medium">
            🤖 AI Trading Aktiv (TESTNET)
          </div>
        )}
      </div>
      
      <div className="text-xs text-gray-500 mb-3">
        Autonom kryptohandel med AI + riskhantering
      </div>

      <div className="flex gap-2">
        {!isRunning ? (
          <Button 
            onClick={startAutonomousTrading} 
            size="sm" 
            className="flex-1 bg-green-600 hover:bg-green-700"
          >
            <Play className="w-3 h-3 mr-1" />
            Starta Bot
          </Button>
        ) : (
          <Button 
            onClick={stopTrading} 
            size="sm" 
            variant="destructive" 
            className="flex-1"
          >
            <Pause className="w-3 h-3 mr-1" />
            Stoppa Bot
          </Button>
        )}
      </div>

      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 bg-yellow-500 border-2 border-white"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="w-3 h-3 bg-yellow-500 border-2 border-white"
      />
    </div>
  );
});

export default BinanceNode;