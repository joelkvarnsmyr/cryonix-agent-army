import { useState, useCallback, useRef, useEffect } from "react";
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
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAgents } from "@/hooks/useAgents";

// Custom node types
import TriggerNode from "@/components/flow/nodes/TriggerNode";
import GPTNode from "@/components/flow/nodes/GPTNode";
import BinanceNode from "@/components/flow/nodes/BinanceNode";
import EmailNode from "@/components/flow/nodes/EmailNode";
import ConditionNode from "@/components/flow/nodes/ConditionNode";
import WebhookNode from "@/components/flow/nodes/WebhookNode";
import NodeToolbox from "@/components/flow/NodeToolbox";
import NodeConfigPanel from "@/components/flow/NodeConfigPanel";

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
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { createAgent, updateAgent, agents } = useAgents();
  const editingAgentId = searchParams.get('edit');
  const [isEditing, setIsEditing] = useState(false);

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

  // Load existing agent data when editing
  useEffect(() => {
    if (editingAgentId && agents.length > 0) {
      const agentToEdit = agents.find(agent => agent.id === editingAgentId);
      if (agentToEdit) {
        setIsEditing(true);
        setAgentName(agentToEdit.name);
        setAgentDescription(agentToEdit.description || "");
        
        // Load configuration if available
        if (agentToEdit.configuration) {
          if (agentToEdit.configuration.nodes && agentToEdit.configuration.nodes.length > 0) {
            setNodes(agentToEdit.configuration.nodes);
          } else {
            // Generate default flow if none exists
            generateDefaultFlow(agentToEdit.agent_type);
          }
          if (agentToEdit.configuration.edges) {
            setEdges(agentToEdit.configuration.edges);
          }
          if (agentToEdit.configuration.flowDescription) {
            setFlowDescription(agentToEdit.configuration.flowDescription);
          }
        } else {
          // Generate default flow for agents without configuration
          generateDefaultFlow(agentToEdit.agent_type);
        }
      }
    }
  }, [editingAgentId, agents, setNodes, setEdges]);

  const generateDefaultFlow = (agentType: string) => {
    const defaultFlows = {
      cryptotrader: {
        nodes: [
          {
            id: '1',
            type: 'trigger',
            position: { x: 100, y: 100 },
            data: { label: 'Market Analysis Trigger', triggerType: 'schedule' }
          },
          {
            id: '2', 
            type: 'binance',
            position: { x: 300, y: 100 },
            data: { label: 'Get Market Data', action: 'get_price' }
          },
          {
            id: '3',
            type: 'gpt',
            position: { x: 500, y: 100 },
            data: { label: 'AI Analysis', prompt: 'Analyze market data and recommend action' }
          },
          {
            id: '4',
            type: 'condition',
            position: { x: 700, y: 100 },
            data: { label: 'Trade Decision', condition: 'confidence > 80' }
          },
          {
            id: '5',
            type: 'binance',
            position: { x: 500, y: 250 },
            data: { label: 'Execute Trade', action: 'buy_sell' }
          }
        ],
        edges: [
          { id: 'e1-2', source: '1', target: '2' },
          { id: 'e2-3', source: '2', target: '3' },
          { id: 'e3-4', source: '3', target: '4' },
          { id: 'e4-5', source: '4', target: '5' }
        ]
      },
      email_manager: {
        nodes: [
          {
            id: '1',
            type: 'trigger',
            position: { x: 100, y: 100 },
            data: { label: 'New Email Trigger', triggerType: 'webhook' }
          },
          {
            id: '2',
            type: 'email',
            position: { x: 300, y: 100 },
            data: { label: 'Read Email', action: 'read' }
          },
          {
            id: '3',
            type: 'gpt',
            position: { x: 500, y: 100 },
            data: { label: 'Analyze Email', prompt: 'Categorize and analyze this email' }
          },
          {
            id: '4',
            type: 'condition',
            position: { x: 700, y: 100 },
            data: { label: 'Needs Reply?', condition: 'priority == high' }
          },
          {
            id: '5',
            type: 'email',
            position: { x: 500, y: 250 },
            data: { label: 'Send Reply', action: 'reply' }
          }
        ],
        edges: [
          { id: 'e1-2', source: '1', target: '2' },
          { id: 'e2-3', source: '2', target: '3' },
          { id: 'e3-4', source: '3', target: '4' },
          { id: 'e4-5', source: '4', target: '5' }
        ]
      },
      scheduler: {
        nodes: [
          {
            id: '1',
            type: 'trigger',
            position: { x: 100, y: 100 },
            data: { label: 'Daily Schedule Check', triggerType: 'schedule' }
          },
          {
            id: '2',
            type: 'webhook',
            position: { x: 300, y: 100 },
            data: { label: 'Get Calendar Data', url: 'calendar_api' }
          },
          {
            id: '3',
            type: 'gpt',
            position: { x: 500, y: 100 },
            data: { label: 'Optimize Schedule', prompt: 'Analyze schedule and suggest optimizations' }
          }
        ],
        edges: [
          { id: 'e1-2', source: '1', target: '2' },
          { id: 'e2-3', source: '2', target: '3' }
        ]
      }
    };

    const flow = defaultFlows[agentType as keyof typeof defaultFlows] || defaultFlows.scheduler;
    setNodes(flow.nodes);
    setEdges(flow.edges);
  };

  const saveAgent = async () => {
    try {
      const flowData = {
        name: agentName,
        description: agentDescription,
        agent_type: 'custom',
        status: 'inactive',
        configuration: {
          nodes,
          edges,
          flowDescription
        }
      };

      if (isEditing && editingAgentId) {
        // Update existing agent
        const updatedAgent = await updateAgent(editingAgentId, {
          configuration: flowData.configuration
        });
        
        if (updatedAgent) {
          toast({
            title: "Agent uppdaterad! ✨",
            description: `${agentName} har uppdaterats framgångsrikt.`,
          });
          navigate("/agents");
        }
      } else {
        // Create new agent
        const savedAgent = await createAgent(flowData);
        
        if (savedAgent) {
          toast({
            title: "Agent sparad! ✨",
            description: `${agentName} har sparats och kan nu användas.`,
          });
          navigate("/agents");
        }
      }
    } catch (error) {
      console.error('Save error:', error);
      toast({
        title: "Fel",
        description: `Kunde inte ${isEditing ? 'uppdatera' : 'spara'} agenten.`,
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

  const onNodeClick = (event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  };

  const onUpdateNode = (nodeId: string, data: any) => {
    setNodes((nds) =>
      nds.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node
      )
    );
    toast({
      title: "Node uppdaterad",
      description: "Nodkonfigurationen har sparats.",
    });
  };

  const onDeleteNode = (nodeId: string) => {
    setNodes((nds) => nds.filter((node) => node.id !== nodeId));
    setEdges((eds) => eds.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setSelectedNode(null);
    toast({
      title: "Node borttagen",
      description: "Noden och dess kopplingar har tagits bort.",
    });
  };

  return (
    <div className="h-screen flex"
      onClick={(e) => {
        // Deselect node when clicking on background
        if (e.target === e.currentTarget) {
          setSelectedNode(null);
        }
      }}
    >
      {/* Left Sidebar - Node Toolbox & Basic Config */}
      <div className="w-80 border-r bg-background flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b">
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
        <div className="p-4 border-b">
          <Card className="glass">
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
        </div>

        {/* Node Toolbox */}
        <div className="flex-1 overflow-y-auto p-4">
          <NodeToolbox />
        </div>

        {/* Action Buttons */}
        <div className="p-4 border-t space-y-3">
          <Button onClick={saveAgent} className="w-full" variant="outline">
            <Save className="w-4 h-4 mr-2" />
            {isEditing ? 'Uppdatera Agent' : 'Spara Agent'}
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
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          className="bg-gray-50"
        >
          <Controls />
          <MiniMap />
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        </ReactFlow>
      </div>

      {/* Right Sidebar - Node Configuration */}
      <div className="w-80 border-l bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        <NodeConfigPanel
          selectedNode={selectedNode}
          onUpdateNode={onUpdateNode}
          onDeleteNode={onDeleteNode}
        />
      </div>
    </div>
  );
};

export default AgentBuilder;