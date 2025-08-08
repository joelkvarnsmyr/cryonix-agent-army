import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { GitBranch, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface ConditionNodeData {
  label: string;
  condition?: string;
  operator?: 'equals' | 'greater' | 'less' | 'contains';
  value?: string;
}

const ConditionNode = memo(({ data }: { data: ConditionNodeData }) => {
  const getOperatorText = () => {
    switch (data.operator) {
      case 'equals': return '==';
      case 'greater': return '>';
      case 'less': return '<';
      case 'contains': return 'innehåller';
      default: return 'if';
    }
  };

  return (
    <div className="bg-white border-2 border-orange-200 rounded-lg p-4 min-w-[250px] shadow-md">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-orange-500 flex items-center justify-center">
            <GitBranch className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="font-semibold text-sm">{data.label}</div>
            <Badge variant="secondary" className="text-xs">
              Logic
            </Badge>
          </div>
        </div>
        <Button variant="ghost" size="sm">
          <Settings className="w-3 h-3" />
        </Button>
      </div>
      
      {data.condition && (
        <div className="space-y-2 mb-3">
          <div className="text-xs">
            <span className="font-medium">Villkor:</span>
          </div>
          <div className="bg-gray-50 p-2 rounded text-xs font-mono">
            {data.condition} {getOperatorText()} {data.value || '...'}
          </div>
        </div>
      )}
      
      <div className="text-xs text-gray-500 mb-2">
        Logisk förgrening baserat på villkor
      </div>

      <div className="flex justify-between text-xs">
        <span className="text-green-600">✓ Sant</span>
        <span className="text-red-600">✗ Falskt</span>
      </div>

      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 bg-orange-500 border-2 border-white"
      />
      
      {/* True output */}
      <Handle
        type="source"
        position={Position.Right}
        id="true"
        className="w-3 h-3 bg-green-500 border-2 border-white"
        style={{ top: '70%' }}
      />
      
      {/* False output */}
      <Handle
        type="source"
        position={Position.Right}
        id="false"
        className="w-3 h-3 bg-red-500 border-2 border-white"
        style={{ top: '90%' }}
      />
    </div>
  );
});

export default ConditionNode;