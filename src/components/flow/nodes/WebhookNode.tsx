import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Globe, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface WebhookNodeData {
  label: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url?: string;
  headers?: Record<string, string>;
}

const WebhookNode = memo(({ data }: { data: WebhookNodeData }) => {
  const getMethodColor = () => {
    switch (data.method) {
      case 'GET': return 'text-blue-600';
      case 'POST': return 'text-green-600';
      case 'PUT': return 'text-orange-600';
      case 'DELETE': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  return (
    <div className="bg-white border-2 border-green-200 rounded-lg p-4 min-w-[250px] shadow-md">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-green-500 flex items-center justify-center">
            <Globe className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="font-semibold text-sm">{data.label}</div>
            <Badge variant="secondary" className="text-xs">
              HTTP Request
            </Badge>
          </div>
        </div>
        <Button variant="ghost" size="sm">
          <Settings className="w-3 h-3" />
        </Button>
      </div>
      
      <div className="space-y-2 mb-3">
        <div className="flex items-center gap-2">
          <Badge 
            variant="outline" 
            className={`text-xs ${getMethodColor()}`}
          >
            {data.method || 'POST'}
          </Badge>
        </div>
        
        {data.url && (
          <div className="text-xs">
            <span className="font-medium">URL:</span>
            <div className="bg-gray-50 p-2 rounded mt-1 text-xs font-mono break-all">
              {data.url.length > 40 
                ? `${data.url.substring(0, 40)}...` 
                : data.url
              }
            </div>
          </div>
        )}
      </div>
      
      <div className="text-xs text-gray-500">
        HTTP webhook för externa integrationer
      </div>

      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 bg-green-500 border-2 border-white"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="w-3 h-3 bg-green-500 border-2 border-white"
      />
    </div>
  );
});

export default WebhookNode;