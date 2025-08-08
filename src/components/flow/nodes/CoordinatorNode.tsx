import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Brain, Mail, Calendar, Bell, MessageCircle, Zap } from 'lucide-react';

interface CoordinatorNodeData {
  label: string;
  agentType: string;
  status: 'idle' | 'thinking' | 'working' | 'delegating';
  activeAgents: string[];
  currentTask?: string;
}

const getAgentIcon = (agentType: string) => {
  switch (agentType) {
    case 'CoordinatorAgent': return Brain;
    case 'MailAgent': return Mail;
    case 'CalendarAgent': return Calendar;
    case 'ReminderAgent': return Bell;
    case 'LLMCoreAgent': return MessageCircle;
    default: return Zap;
  }
};

const CoordinatorNode = memo(({ data }: { data: CoordinatorNodeData }) => {
  const IconComponent = getAgentIcon(data.agentType);
  
  return (
    <Card className="min-w-[200px] shadow-lg border-primary/20">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
            <IconComponent className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-sm">{data.label}</h3>
            <p className="text-xs text-muted-foreground">{data.agentType}</p>
          </div>
        </div>
        
        <div className="space-y-2">
          <Badge 
            variant={data.status === 'working' ? 'default' : 'secondary'}
            className="text-xs"
          >
            {data.status === 'idle' && '⏸️ Idle'}
            {data.status === 'thinking' && '🧠 Thinking'}
            {data.status === 'working' && '⚡ Working'}
            {data.status === 'delegating' && '📤 Delegating'}
          </Badge>
          
          {data.currentTask && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {data.currentTask}
            </p>
          )}
          
          {data.activeAgents.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {data.activeAgents.map((agent, index) => (
                <Badge key={index} variant="outline" className="text-xs">
                  {agent}
                </Badge>
              ))}
            </div>
          )}
        </div>
        
        <Handle 
          type="target" 
          position={Position.Left} 
          className="w-2 h-2 bg-primary"
        />
        <Handle 
          type="source" 
          position={Position.Right} 
          className="w-2 h-2 bg-primary"
        />
      </CardContent>
    </Card>
  );
});

CoordinatorNode.displayName = 'CoordinatorNode';

export default CoordinatorNode;