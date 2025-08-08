import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Bot, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface GPTNodeData {
  label: string;
  model?: 'gpt-4o-mini' | 'gpt-4o';
  prompt?: string;
  temperature?: number;
}

const GPTNode = memo(({ data }: { data: GPTNodeData }) => {
  return (
    <div className="bg-white border-2 border-purple-200 rounded-lg p-4 min-w-[250px] shadow-md">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-purple-500 flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="font-semibold text-sm">{data.label}</div>
            <Badge variant="secondary" className="text-xs">
              AI Processing
            </Badge>
          </div>
        </div>
        <Button variant="ghost" size="sm">
          <Settings className="w-3 h-3" />
        </Button>
      </div>
      
      <div className="space-y-2 mb-3">
        <div className="text-xs">
          <span className="font-medium">Model:</span> {data.model || 'gpt-4o-mini'}
        </div>
        {data.prompt && (
          <div className="text-xs">
            <span className="font-medium">Prompt:</span>
            <div className="bg-gray-50 p-2 rounded mt-1 text-xs">
              {data.prompt.length > 50 
                ? `${data.prompt.substring(0, 50)}...` 
                : data.prompt
              }
            </div>
          </div>
        )}
      </div>
      
      <div className="text-xs text-gray-500">
        Bearbetar data med AI
      </div>

      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 bg-purple-500 border-2 border-white"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="w-3 h-3 bg-purple-500 border-2 border-white"
      />
    </div>
  );
});

export default GPTNode;