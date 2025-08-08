import { useState, useEffect, useCallback } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useAgentSystem } from "@/hooks/useAgentSystem";
import { 
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { 
  Bot, 
  Brain,
  Settings,
  Play,
  Square,
  Plus,
  Users,
  Activity,
  Clock
} from "lucide-react";
import { v4 as uuidv4 } from 'uuid';

// Import our custom agent nodes
import CoordinatorNode from "@/components/flow/nodes/CoordinatorNode";
import MailAgentNode from "@/components/flow/nodes/MailAgentNode";
import CalendarAgentNode from "@/components/flow/nodes/CalendarAgentNode";
import MemoryAgentNode from "@/components/flow/nodes/MemoryAgentNode";

const nodeTypes = {
  coordinator: CoordinatorNode,
  mailAgent: MailAgentNode,
  calendarAgent: CalendarAgentNode,
  memoryAgent: MemoryAgentNode,
};

const AgentOrchestrator = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const { 
    agentTypes, 
    agents, 
    createAgent, 
    activateAgent, 
    deactivateAgent,
    createCoordinatorSession,
    currentSession 
  } = useAgentSystem();

  const [sessionId] = useState(() => uuidv4());
  const [isOrchestrating, setIsOrchestrating] = useState(false);
  const [orchestrationStatus, setOrchestrationStatus] = useState<'idle' | 'running' | 'paused'>('idle');

  // Agent settings modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [emailConfig, setEmailConfig] = useState({
    systemPrompt: '',
    objectives: '',
    autoArchive: false,
    autoMove: true,
  });

  const openSettings = (agentId: string) => {
    setSelectedAgentId(agentId);
    setIsSettingsOpen(true);
  };

  const handleSaveSettings = () => {
    toast({ title: 'Inställningar sparade', description: 'Agentens inställningar uppdaterades.' });
    setIsSettingsOpen(false);
  };

  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [],
  );

  useEffect(() => {
    if (user && !currentSession) {
      createCoordinatorSession(sessionId);
    }
  }, [user, currentSession, sessionId, createCoordinatorSession]);

  useEffect(() => {
    // Initialize the flow with default nodes when agents are loaded
    if (agents.length > 0) {
      initializeAgentFlow();
    }
  }, [agents]);

  const initializeAgentFlow = () => {
    const coordinatorAgent = agents.find(a => a.agent_type === 'CoordinatorAgent');
    const mailAgent = agents.find(a => a.agent_type === 'MailAgent');
    const calendarAgent = agents.find(a => a.agent_type === 'CalendarAgent');
    const memoryAgent = agents.find(a => a.agent_type === 'MemoryAgent');

    const initialNodes: Node[] = [];
    const initialEdges: Edge[] = [];

    // Coordinator Node (center)
    if (coordinatorAgent) {
      initialNodes.push({
        id: 'coordinator',
        type: 'coordinator',
        position: { x: 300, y: 200 },
        data: {
          label: coordinatorAgent.name,
          agentType: 'CoordinatorAgent',
          status: coordinatorAgent.status === 'active' ? 'delegating' : 'idle',
          activeAgents: agents.filter(a => a.status === 'active').map(a => a.agent_type),
          currentTask: isOrchestrating ? 'Coordinating agent tasks' : undefined
        }
      });
    }

    // Mail Agent (top-left)
    if (mailAgent) {
      initialNodes.push({
        id: 'mail-agent',
        type: 'mailAgent',
        position: { x: 50, y: 50 },
        data: {
          label: mailAgent.name,
          status: mailAgent.status === 'active' ? 'checking' : 'idle',
          emailCount: 12,
          priorityEmails: 3,
          lastCheck: '2 min ago',
          currentAction: mailAgent.status === 'active' ? 'Analyzing incoming emails' : undefined
        }
      });

      // Connect to coordinator
      if (coordinatorAgent) {
        initialEdges.push({
          id: 'mail-to-coordinator',
          source: 'mail-agent',
          target: 'coordinator',
          type: 'smoothstep',
          animated: mailAgent.status === 'active'
        });
      }
    }

    // Calendar Agent (top-right)
    if (calendarAgent) {
      initialNodes.push({
        id: 'calendar-agent',
        type: 'calendarAgent',
        position: { x: 550, y: 50 },
        data: {
          label: calendarAgent.name,
          status: calendarAgent.status === 'active' ? 'checking' : 'idle',
          todayMeetings: 3,
          upcomingMeetings: 8,
          conflicts: 0,
          nextMeeting: 'Team sync at 2:00 PM',
          currentAction: calendarAgent.status === 'active' ? 'Checking for conflicts' : undefined
        }
      });

      // Connect to coordinator
      if (coordinatorAgent) {
        initialEdges.push({
          id: 'calendar-to-coordinator',
          source: 'calendar-agent',
          target: 'coordinator',
          type: 'smoothstep',
          animated: calendarAgent.status === 'active'
        });
      }
    }

    // Memory Agent (bottom)
    if (memoryAgent) {
      initialNodes.push({
        id: 'memory-agent',
        type: 'memoryAgent',
        position: { x: 300, y: 400 },
        data: {
          label: memoryAgent.name,
          status: memoryAgent.status === 'active' ? 'storing' : 'idle',
          memoryEntries: 157,
          contextSize: 12,
          lastAccess: '30s ago',
          currentOperation: memoryAgent.status === 'active' ? 'Storing conversation context' : undefined
        }
      });

      // Connect to coordinator
      if (coordinatorAgent) {
        initialEdges.push({
          id: 'coordinator-to-memory',
          source: 'coordinator',
          target: 'memory-agent',
          type: 'smoothstep',
          animated: memoryAgent.status === 'active'
        });
      }
    }

    setNodes(initialNodes);
    setEdges(initialEdges);
  };

  const startOrchestration = async () => {
    setIsOrchestrating(true);
    setOrchestrationStatus('running');
    
    // Activate all agents
    for (const agent of agents) {
      if (agent.status === 'inactive') {
        await activateAgent(agent.id);
      }
    }

    // Update flow to show active state
    initializeAgentFlow();

    toast({
      title: "Orchestration Started",
      description: "All agents are now active and coordinating",
    });
  };

  const stopOrchestration = async () => {
    setIsOrchestrating(false);
    setOrchestrationStatus('idle');
    
    // Deactivate non-coordinator agents
    for (const agent of agents) {
      if (agent.agent_type !== 'CoordinatorAgent' && agent.status === 'active') {
        await deactivateAgent(agent.id);
      }
    }

    // Update flow to show inactive state
    initializeAgentFlow();

    toast({
      title: "Orchestration Stopped",
      description: "Agents have been deactivated",
    });
  };

  const createMissingAgents = async () => {
    const requiredAgentTypes = ['CoordinatorAgent', 'MailAgent', 'CalendarAgent', 'MemoryAgent'];
    const existingTypes = agents.map(a => a.agent_type);
    
    for (const agentTypeName of requiredAgentTypes) {
      if (!existingTypes.includes(agentTypeName)) {
        const agentType = agentTypes.find(t => t.name === agentTypeName);
        if (agentType) {
          await createAgent(agentType.id);
        }
      }
    }

    toast({
      title: "Agent Setup Complete",
      description: "All required agents have been created",
    });
  };

  const activeAgentCount = agents.filter(a => a.status === 'active').length;
  const requiredAgentTypes = ['CoordinatorAgent', 'MailAgent', 'CalendarAgent', 'MemoryAgent'];
  const missingAgents = requiredAgentTypes.filter(type => 
    !agents.some(a => a.agent_type === type)
  );

  return (
    <div className="h-screen flex flex-col bg-background">
      
      <main className="flex-1 flex pt-0">
        {/* Flow Visualization Area */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="border-b bg-card/50 p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Bot className="w-6 h-6 text-primary" />
                <div>
                  <h1 className="font-medium">Agent Orchestrator</h1>
                  <p className="text-sm text-muted-foreground">Visual agent coordination system</p>
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <Badge 
                variant={orchestrationStatus === 'running' ? 'default' : 'secondary'}
                className="flex items-center gap-1"
              >
                <Activity className="w-3 h-3" />
                {orchestrationStatus === 'running' ? 'Active' : 'Idle'}
              </Badge>
              
              {missingAgents.length === 0 ? (
                orchestrationStatus === 'running' ? (
                  <Button onClick={stopOrchestration} variant="outline" size="sm">
                    <Square className="w-4 h-4 mr-2" />
                    Stop
                  </Button>
                ) : (
                  <Button onClick={startOrchestration} size="sm">
                    <Play className="w-4 h-4 mr-2" />
                    Start
                  </Button>
                )
              ) : (
                <Button onClick={createMissingAgents} size="sm">
                  <Plus className="w-4 h-4 mr-2" />
                  Setup Agents
                </Button>
              )}
            </div>
          </div>

          {/* React Flow Canvas */}
          <div className="flex-1">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              style={{ backgroundColor: "hsl(var(--background))" }}
            >
              <Background />
              <Controls />
              <MiniMap 
                zoomable 
                pannable 
                style={{
                  backgroundColor: "hsl(var(--muted))",
                }}
              />
            </ReactFlow>
          </div>
        </div>

        {/* Agent Status Sidebar */}
        <div className="w-80 border-l bg-card/30 p-4">
          <h2 className="font-medium mb-4 flex items-center gap-2">
            <Brain className="w-4 h-4" />
            System Status
          </h2>
          
          {/* System Overview */}
          <Card className="glass mb-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Overview</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="font-medium">{agents.length}</div>
                  <div className="text-muted-foreground">Total Agents</div>
                </div>
                <div>
                  <div className="font-medium text-primary">{activeAgentCount}</div>
                  <div className="text-muted-foreground">Active</div>
                </div>
              </div>
              
              {currentSession && (
                <div className="mt-2 pt-2 border-t">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    Session: {sessionId.slice(0, 8)}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Agent List */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Users className="w-4 h-4" />
              Agents ({agents.length})
            </h3>
            
            <ScrollArea className="h-[400px]">
              <div className="space-y-2">
                {agents.map((agent) => (
                  <Card key={agent.id} className="glass">
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">{agent.name}</h4>
                        <Badge 
                          variant={agent.status === 'active' ? 'default' : 'secondary'}
                          className="text-xs"
                        >
                          {agent.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mb-2">
                        {agent.agent_type}
                      </p>
                      <div className="flex gap-1">
                        <Button 
                          size="sm" 
                          variant="outline" 
                          className="text-xs h-6"
                          onClick={() => agent.status === 'active' ? deactivateAgent(agent.id) : activateAgent(agent.id)}
                        >
                          {agent.status === 'active' ? 'Pause' : 'Start'}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-xs h-6" onClick={() => openSettings(agent.id)}>
                          <Settings className="w-3 h-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </ScrollArea>
          </div>

          {missingAgents.length > 0 && (
            <Card className="glass mt-4 border-warning/30">
              <CardContent className="p-3">
                <h4 className="font-medium text-sm text-warning mb-2">Setup Required</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  Missing agents: {missingAgents.join(', ')}
                </p>
                <Button onClick={createMissingAgents} size="sm" className="w-full">
                  Create Missing Agents
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
        <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Agentinställningar</DialogTitle>
            </DialogHeader>

            <Tabs defaultValue="koppling" className="mt-2">
              <TabsList className="grid grid-cols-4">
                <TabsTrigger value="koppling">Koppling</TabsTrigger>
                <TabsTrigger value="uppdrag">Uppdrag & Prompts</TabsTrigger>
                <TabsTrigger value="regler">Regler/Mappar</TabsTrigger>
                <TabsTrigger value="auto">Automatisering</TabsTrigger>
              </TabsList>

              <TabsContent value="koppling">
                <p className="text-sm text-muted-foreground mb-3">
                  Hantera e‑postkopplingar under Integrationer.
                </p>
                <Button onClick={() => (window.location.href = '/integrations')}>
                  Öppna Integrationer
                </Button>
              </TabsContent>

              <TabsContent value="uppdrag">
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="objectives">Uppdrag</Label>
                    <Textarea
                      id="objectives"
                      placeholder="Beskriv agentens mål..."
                      value={emailConfig.objectives}
                      onChange={(e) => setEmailConfig({ ...emailConfig, objectives: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="systemPrompt">Systemprompt</Label>
                    <Textarea
                      id="systemPrompt"
                      placeholder="Tonalitet, policy, stil..."
                      value={emailConfig.systemPrompt}
                      onChange={(e) => setEmailConfig({ ...emailConfig, systemPrompt: e.target.value })}
                    />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="regler">
                <p className="text-sm text-muted-foreground mb-3">Kommer: definiera mappar/labels och filtreringsregler.</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Exempelregel</Label>
                    <Input placeholder="Från: faktura@..., Label: Ekonomi" disabled />
                  </div>
                  <div>
                    <Label>Exempelregel</Label>
                    <Input placeholder="Ämne innehåller: möte → Label: Kalender" disabled />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="auto">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Auto-arkivera hanterade trådar</Label>
                      <p className="text-xs text-muted-foreground">Håll inkorgen ren automatiskt.</p>
                    </div>
                    <Switch
                      checked={emailConfig.autoArchive}
                      onCheckedChange={(v) => setEmailConfig({ ...emailConfig, autoArchive: v })}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Auto-flytta enligt regler</Label>
                      <p className="text-xs text-muted-foreground">Flytta mail till mappar utan att fråga.</p>
                    </div>
                    <Switch
                      checked={emailConfig.autoMove}
                      onCheckedChange={(v) => setEmailConfig({ ...emailConfig, autoMove: v })}
                    />
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setIsSettingsOpen(false)}>Avbryt</Button>
              <Button onClick={handleSaveSettings}>Spara</Button>
            </div>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
};

export default AgentOrchestrator;