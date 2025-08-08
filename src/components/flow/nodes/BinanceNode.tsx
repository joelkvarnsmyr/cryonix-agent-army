import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { TrendingUp, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface BinanceNodeData {
  label: string;
  action?: 'buy' | 'sell' | 'get_price' | 'get_balance';
  symbol?: string;
  amount?: number;
}

const BinanceNode = memo(({ data }: { data: BinanceNodeData }) => {
  const getActionText = () => {
    switch (data.action) {
      case 'buy': return 'Köp Order';
      case 'sell': return 'Sälj Order';
      case 'get_price': return 'Hämta Pris';
      case 'get_balance': return 'Kontrollera Saldo';
      default: return 'Binance API';
    }
  };

  const getActionColor = () => {
    switch (data.action) {
      case 'buy': return 'text-green-600';
      case 'sell': return 'text-red-600';
      default: return 'text-yellow-600';
    }
  };

  return (
    <div className="bg-white border-2 border-yellow-200 rounded-lg p-4 min-w-[250px] shadow-md">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-yellow-500 flex items-center justify-center">
            <TrendingUp className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="font-semibold text-sm">{data.label}</div>
            <Badge variant="secondary" className="text-xs">
              Trading API
            </Badge>
          </div>
        </div>
        <Button variant="ghost" size="sm">
          <Settings className="w-3 h-3" />
        </Button>
      </div>
      
      <div className="space-y-2 mb-3">
        <div className={`text-xs font-medium ${getActionColor()}`}>
          {getActionText()}
        </div>
        {data.symbol && (
          <div className="text-xs">
            <span className="font-medium">Symbol:</span> {data.symbol}
          </div>
        )}
        {data.amount && (
          <div className="text-xs">
            <span className="font-medium">Amount:</span> {data.amount}
          </div>
        )}
      </div>
      
      <div className="text-xs text-gray-500">
        Kryptovaluta trading via Binance
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