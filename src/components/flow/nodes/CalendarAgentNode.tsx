import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, CheckCircle, AlertCircle, Clock, Users } from 'lucide-react';

interface CalendarAgentNodeData {
  label: string;
  status: 'idle' | 'checking' | 'scheduling' | 'updating';
  todayMeetings: number;
  upcomingMeetings: number;
  conflicts: number;
  nextMeeting?: string;
  currentAction?: string;
}

const CalendarAgentNode = memo(({ data }: { data: CalendarAgentNodeData }) => {
  return (
    <Card className="min-w-[180px] shadow-lg border-success/20">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-success/10 flex items-center justify-center">
            <Calendar className="w-4 h-4 text-success" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-sm">{data.label}</h3>
            <p className="text-xs text-muted-foreground">Schedule Management</p>
          </div>
        </div>
        
        <div className="space-y-2">
          <Badge 
            variant={data.status === 'scheduling' ? 'default' : 'secondary'}
            className="text-xs"
          >
            {data.status === 'idle' && '📅 Ready'}
            {data.status === 'checking' && '🔍 Checking'}
            {data.status === 'scheduling' && '⏰ Scheduling'}
            {data.status === 'updating' && '✏️ Updating'}
          </Badge>
          
          <div className="grid grid-cols-3 gap-1 text-xs">
            <div className="text-center">
              <div className="font-medium">{data.todayMeetings}</div>
              <div className="text-muted-foreground">Today</div>
            </div>
            <div className="text-center">
              <div className="font-medium">{data.upcomingMeetings}</div>
              <div className="text-muted-foreground">Week</div>
            </div>
            <div className="text-center">
              <div className="font-medium text-red-500">{data.conflicts}</div>
              <div className="text-muted-foreground">Conflicts</div>
            </div>
          </div>
          
          {data.nextMeeting && (
            <div className="flex items-center gap-1 text-xs">
              <Users className="w-3 h-3" />
              <span className="truncate">{data.nextMeeting}</span>
            </div>
          )}
          
          {data.currentAction && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {data.currentAction}
            </p>
          )}
        </div>
        
        <Handle 
          type="target" 
          position={Position.Top} 
          className="w-2 h-2 bg-success"
        />
        <Handle 
          type="source" 
          position={Position.Bottom} 
          className="w-2 h-2 bg-success"
        />
      </CardContent>
    </Card>
  );
});

CalendarAgentNode.displayName = 'CalendarAgentNode';

export default CalendarAgentNode;