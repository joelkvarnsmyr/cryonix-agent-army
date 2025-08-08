import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Mail, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface EmailNodeData {
  label: string;
  action?: 'send' | 'read' | 'reply';
  to?: string;
  subject?: string;
}

const EmailNode = memo(({ data }: { data: EmailNodeData }) => {
  const getActionText = () => {
    switch (data.action) {
      case 'send': return 'Skicka Email';
      case 'read': return 'Läs Email';
      case 'reply': return 'Svara på Email';
      default: return 'Email Operation';
    }
  };

  const getActionIcon = () => {
    return <Mail className="w-4 h-4 text-white" />;
  };

  return (
    <div className="bg-white border-2 border-red-200 rounded-lg p-4 min-w-[250px] shadow-md">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-red-500 flex items-center justify-center">
            {getActionIcon()}
          </div>
          <div>
            <div className="font-semibold text-sm">{data.label}</div>
            <Badge variant="secondary" className="text-xs">
              Email
            </Badge>
          </div>
        </div>
        <Button variant="ghost" size="sm">
          <Settings className="w-3 h-3" />
        </Button>
      </div>
      
      <div className="space-y-2 mb-3">
        <div className="text-xs font-medium text-red-600">
          {getActionText()}
        </div>
        {data.to && (
          <div className="text-xs">
            <span className="font-medium">Till:</span> {data.to}
          </div>
        )}
        {data.subject && (
          <div className="text-xs">
            <span className="font-medium">Ämne:</span> {data.subject}
          </div>
        )}
      </div>
      
      <div className="text-xs text-gray-500">
        E-posthantering och kommunikation
      </div>

      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 bg-red-500 border-2 border-white"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="w-3 h-3 bg-red-500 border-2 border-white"
      />
    </div>
  );
});

export default EmailNode;