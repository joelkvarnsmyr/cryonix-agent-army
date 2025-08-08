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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Save, Play, Eye, Bot, ArrowLeft, Sparkles, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

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
  const [flowDescription, setFlowDescription] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
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

  const generateFlowWithAI = async () => {
    if (!flowDescription.trim()) {
      toast({
        title: "Beskrivning saknas",
        description: "Beskriv vad din agent ska göra.",
        variant: "destructive",
      });
      return;
    }

    setIsGenerating(true);
    
    try {
      const { data, error } = await supabase.functions.invoke('generate-flow', {
        body: {
          description: flowDescription,
          agentType: 'custom',
        },
      });

      if (error) throw error;

      if (data.success) {
        // Replace current flow with AI-generated flow
        setNodes(data.flow.nodes);
        setEdges(data.flow.edges);
        
        // Update agent name if not already set
        if (agentName === "Min Nya Agent") {
          setAgentName(data.flow.nodes[0]?.data?.label || "AI Genererad Agent");
        }
        
        toast({
          title: "Flöde genererat! ✨",
          description: "AI har skapat ett komplett flöde baserat på din beskrivning.",
        });
      } else {
        throw new Error(data.error || 'Unknown error');
      }
    } catch (error: any) {
      console.error('Error generating flow:', error);
      toast({
        title: "Fel vid generering",
        description: error.message || "Kunde inte generera flödet. Kontrollera att OpenAI API-nyckeln är konfigurerad.",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const clearFlow = () => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    setFlowDescription("");
    toast({
      title: "Flöde rensad",
      description: "Canvas har återställts till starttillstånd.",
    });
  };

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

        {/* AI Flow Generator */}
        <Card className="glass mb-6">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-500" />
              AI Flödes-Generator
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="flow-description">Beskriv vad din agent ska göra</Label>
              <Textarea
                id="flow-description"
                value={flowDescription}
                onChange={(e) => setFlowDescription(e.target.value)}
                placeholder="T.ex: 'Läs nya emails, analysera dem med AI och svara automatiskt på enkla frågor'"
                rows={3}
                className="resize-none"
              />
            </div>
            <div className="flex gap-2">
              <Button 
                onClick={generateFlowWithAI} 
                className="flex-1 gradient-primary shadow-primary"
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Genererar...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Skapa Flöde med AI
                  </>
                )}
              </Button>
              <Button 
                onClick={clearFlow} 
                variant="outline"
                disabled={isGenerating}
              >
                Rensa
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              💡 AI skapar ett komplett flöde som du sedan kan granska och justera
            </div>
          </CardContent>
        </Card>

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
            disabled={isExecuting || isGenerating}
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