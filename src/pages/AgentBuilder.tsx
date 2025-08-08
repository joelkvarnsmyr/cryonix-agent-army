import { useState, useCallback, useRef } from "react";
import {
  ReactFlow,
  addEdge,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  Connection,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { Save, Play, Eye, Bot, ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

// Custom node types
import TriggerNode from "@/components/flow/nodes/TriggerNode";
import GPTNode from "@/components/flow/nodes/GPTNode";
import BinanceNode from "@/components/flow/nodes/BinanceNode";
import EmailNode from "@/components/flow/nodes/EmailNode";
import ConditionNode from "@/components/flow/nodes/ConditionNode";
import WebhookNode from "@/components/flow/nodes/WebhookNode";
import NodeToolbox from "@/components/flow/NodeToolbox";

const nodeTypes = {
  trigger: TriggerNode,
  gpt: GPTNode,
  binance: BinanceNode,
  email: EmailNode,
  condition: ConditionNode,
  webhook: WebhookNode,
};

const initialNodes: Node[] = [
  {
    id: '1',
    type: 'trigger',
    position: { x: 250, y: 100 },
    data: { 
      label: 'Start',
      triggerType: 'manual',
    },
  },
];

const initialEdges: Edge[] = [];

const AgentBuilder = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [agentName, setAgentName] = useState("Min Nya Agent");
  const [agentDescription, setAgentDescription] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const navigate = useNavigate();

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      if (!reactFlowWrapper.current) return;

      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      const type = event.dataTransfer.getData('application/reactflow');

      if (!type) return;

      const position = {
        x: event.clientX - reactFlowBounds.left - 75,
        y: event.clientY - reactFlowBounds.top - 25,
      };

      const newNode = {
        id: `${Date.now()}`,
        type,
        position,
        data: { 
          label: `${type.toUpperCase()} Node`,
          nodeType: type,
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [setNodes],
  );

  const saveAgent = async () => {
    try {
      // Save the flow configuration
      const flowData = {
        name: agentName,
        description: agentDescription,
        nodes,
        edges,
      };

      // In real implementation, save to Supabase
      localStorage.setItem(`agent_${Date.now()}`, JSON.stringify(flowData));
      
      toast({
        title: "Agent sparad!",
        description: `${agentName} har sparats framgångsrikt.`,
      });
    } catch (error) {
      toast({
        title: "Fel",
        description: "Kunde inte spara agenten.",
        variant: "destructive",
      });
    }
  };

  const executeFlow = async () => {
    setIsExecuting(true);
    
    try {
      // Generate execution code from the flow
      const executionPlan = generateExecutionPlan(nodes, edges);
      
      toast({
        title: "Kör agent...",
        description: "Din agent körs nu i bakgrunden.",
      });

      // Execute the flow (simplified for demo)
      setTimeout(() => {
        setIsExecuting(false);
        toast({
          title: "Agent slutförd!",
          description: "Din agent har slutfört sitt arbete.",
        });
      }, 3000);
      
    } catch (error) {
      setIsExecuting(false);
      toast({
        title: "Fel",
        description: "Kunde inte köra agenten.",
        variant: "destructive",
      });
    }
  };

  const generateExecutionPlan = (nodes: Node[], edges: Edge[]) => {
    // This would generate actual executable code from the visual flow
    // For now, it's a placeholder that would:
    // 1. Parse the node connections
    // 2. Generate JavaScript/TypeScript code
    // 3. Return execution plan
    
    const plan = {
      steps: nodes.map(node => ({
        id: node.id,
        type: node.type,
        data: node.data,
      })),
      connections: edges.map(edge => ({
        from: edge.source,
        to: edge.target,
      })),
    };
    
    return plan;
  };

  const previewMode = () => {
    toast({
      title: "Preview Mode",
      description: "Förhandsvisning av agent-flödet.",
    });
  };

  return (
    <div className="h-screen flex">
      {/* Sidebar */}
      <div className="w-80 border-r bg-background p-4 overflow-y-auto">
        <div className="mb-6">
          <Button 
            variant="ghost" 
            onClick={() => navigate("/")}
            className="mb-4"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Tillbaka
          </Button>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="agent-name">Agent Namn</Label>
              <Input
                id="agent-name"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="Min Nya Agent"
              />
            </div>
            <div>
              <Label htmlFor="agent-desc">Beskrivning</Label>
              <Input
                id="agent-desc"
                value={agentDescription}
                onChange={(e) => setAgentDescription(e.target.value)}
                placeholder="Vad gör denna agent?"
              />
            </div>
          </div>
        </div>

        <NodeToolbox />

        <div className="mt-6 space-y-3">
          <Button onClick={saveAgent} className="w-full" variant="outline">
            <Save className="w-4 h-4 mr-2" />
            Spara Agent
          </Button>
          <Button onClick={previewMode} className="w-full" variant="outline">
            <Eye className="w-4 h-4 mr-2" />
            Förhandsgranska
          </Button>
          <Button 
            onClick={executeFlow} 
            className="w-full gradient-primary shadow-primary"
            disabled={isExecuting}
          >
            <Play className="w-4 h-4 mr-2" />
            {isExecuting ? "Kör..." : "Kör Agent"}
          </Button>
        </div>
      </div>

      {/* Flow Canvas */}
      <div className="flex-1" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={nodeTypes}
          fitView
          className="bg-gray-50"
        >
          <Controls />
          <MiniMap />
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
};

export default AgentBuilder;