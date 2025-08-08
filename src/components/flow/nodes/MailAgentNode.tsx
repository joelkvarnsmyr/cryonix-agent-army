import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Mail, CheckCircle, AlertCircle, Clock, Loader2 } from 'lucide-react';

interface MailAgentNodeData {
  label: string;
  status: 'idle' | 'checking' | 'processing' | 'responding';
  emailCount: number;
  priorityEmails: number;
  lastCheck?: string;
  currentAction?: string;
}

const MailAgentNode = memo(({ data }: { data: MailAgentNodeData }) => {
  return (
    <Card className="min-w-[180px] shadow-lg border-accent/20">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center">
            <Mail className="w-4 h-4 text-accent" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-sm">{data.label}</h3>
            <p className="text-xs text-muted-foreground">Email Management</p>
          </div>
        </div>
        
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Badge 
              variant={data.status === 'processing' ? 'default' : 'secondary'}
              className="text-xs flex items-center gap-1"
            >
              {data.status === 'idle' && <><CheckCircle className="w-3 h-3" /> Idle</>}
              {data.status === 'checking' && <><Loader2 className="w-3 h-3 animate-spin" /> Checking</>}
              {data.status === 'processing' && <><Loader2 className="w-3 h-3 animate-spin" /> Processing</>}
              {data.status === 'responding' && <><Mail className="w-3 h-3" /> Responding</>}
            </Badge>
          </div>
          
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="text-center">
              <div className="font-medium">{data.emailCount}</div>
              <div className="text-muted-foreground">Total</div>
            </div>
            <div className="text-center">
              <div className="font-medium text-orange-500">{data.priorityEmails}</div>
              <div className="text-muted-foreground">Priority</div>
            </div>
          </div>
          
          {data.currentAction && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {data.currentAction}
            </p>
          )}
          
          {data.lastCheck && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              Last: {data.lastCheck}
            </div>
          )}
        </div>
        
        <Handle 
          type="target" 
          position={Position.Top} 
          className="w-2 h-2 bg-accent"
        />
        <Handle 
          type="source" 
          position={Position.Bottom} 
          className="w-2 h-2 bg-accent"
        />
      </CardContent>
    </Card>
  );
});

MailAgentNode.displayName = 'MailAgentNode';

export default MailAgentNode;