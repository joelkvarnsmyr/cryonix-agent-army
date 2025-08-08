import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Zap, Clock, Globe } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface TriggerNodeData {
  label: string;
  triggerType?: 'manual' | 'schedule' | 'webhook';
  schedule?: string;
}

const TriggerNode = memo(({ data }: { data: TriggerNodeData }) => {
  const getIcon = () => {
    switch (data.triggerType) {
      case 'schedule':
        return <Clock className="w-4 h-4" />;
      case 'webhook':
        return <Globe className="w-4 h-4" />;
      default:
        return <Zap className="w-4 h-4" />;
    }
  };

  const getColor = () => {
    switch (data.triggerType) {
      case 'schedule':
        return 'bg-orange-500';
      case 'webhook':
        return 'bg-green-500';
      default:
        return 'bg-blue-500';
    }
  };

  return (
    <div className="bg-white border-2 border-gray-200 rounded-lg p-4 min-w-[200px] shadow-md">
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${getColor()}`}>
          {getIcon()}
        </div>
        <div>
          <div className="font-semibold text-sm">{data.label}</div>
          <Badge variant="secondary" className="text-xs">
            Trigger
          </Badge>
        </div>
      </div>
      
      {data.triggerType === 'schedule' && data.schedule && (
        <div className="text-xs text-gray-600 mb-2">
          Kör: {data.schedule}
        </div>
      )}
      
      <div className="text-xs text-gray-500">
        Startar agent-flödet
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="w-3 h-3 bg-blue-500 border-2 border-white"
      />
    </div>
  );
});

export default TriggerNode;