import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Database, Search, Brain, Clock } from 'lucide-react';

interface MemoryAgentNodeData {
  label: string;
  status: 'idle' | 'storing' | 'retrieving' | 'indexing';
  memoryEntries: number;
  contextSize: number;
  lastAccess?: string;
  currentOperation?: string;
}

const MemoryAgentNode = memo(({ data }: { data: MemoryAgentNodeData }) => {
  return (
    <Card className="min-w-[180px] shadow-lg border-warning/20">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-warning/10 flex items-center justify-center">
            <Database className="w-4 h-4 text-warning" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-sm">{data.label}</h3>
            <p className="text-xs text-muted-foreground">Context & Memory</p>
          </div>
        </div>
        
        <div className="space-y-2">
          <Badge 
            variant={data.status === 'retrieving' ? 'default' : 'secondary'}
            className="text-xs flex items-center gap-1"
          >
            {data.status === 'idle' && <><Database className="w-3 h-3" /> Ready</>}
            {data.status === 'storing' && <><Database className="w-3 h-3" /> Storing</>}
            {data.status === 'retrieving' && <><Search className="w-3 h-3" /> Retrieving</>}
            {data.status === 'indexing' && <><Brain className="w-3 h-3" /> Indexing</>}
          </Badge>
          
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="text-center">
              <div className="font-medium">{data.memoryEntries}</div>
              <div className="text-muted-foreground">Memories</div>
            </div>
            <div className="text-center">
              <div className="font-medium">{data.contextSize}K</div>
              <div className="text-muted-foreground">Context</div>
            </div>
          </div>
          
          {data.currentOperation && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {data.currentOperation}
            </p>
          )}
          
          {data.lastAccess && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              Access: {data.lastAccess}
            </div>
          )}
        </div>
        
        <Handle 
          type="target" 
          position={Position.Left} 
          className="w-2 h-2 bg-warning"
        />
        <Handle 
          type="source" 
          position={Position.Right} 
          className="w-2 h-2 bg-warning"
        />
      </CardContent>
    </Card>
  );
});

MemoryAgentNode.displayName = 'MemoryAgentNode';

export default MemoryAgentNode;