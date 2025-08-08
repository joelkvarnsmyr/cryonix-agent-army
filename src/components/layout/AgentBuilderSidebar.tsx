import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { 
  ArrowLeft,
  Save,
  Play,
  Eye,
  Sparkles,
  Loader2,
  Bot,
  Zap,
  Settings,
  TrendingUp,
  Mail,
  Clock,
  Globe,
  MessageCircle,
  Webhook
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";

interface AgentBuilderSidebarProps {
  agentName: string;
  setAgentName: (name: string) => void;
  agentDescription: string;
  setAgentDescription: (desc: string) => void;
  flowDescription: string;
  setFlowDescription: (desc: string) => void;
  isGenerating: boolean;
  isExecuting: boolean;
  isEditing: boolean;
  onGenerateFlow: () => void;
  onClearFlow: () => void;
  onSaveAgent: () => void;
  onPreviewMode: () => void;
  onExecuteFlow: () => void;
}

const nodeTypes = [
  { type: 'trigger', label: 'Manual Trigger', icon: Zap, color: 'bg-blue-500' },
  { type: 'trigger', label: 'Schedule Trigger', icon: Clock, color: 'bg-orange-500' },
  { type: 'trigger', label: 'Webhook Trigger', icon: Globe, color: 'bg-green-500' },
  { type: 'gpt', label: 'AI Processing', icon: Bot, color: 'bg-purple-500' },
  { type: 'binance', label: 'Crypto Trading', icon: TrendingUp, color: 'bg-yellow-500' },
  { type: 'email', label: 'Email Handler', icon: Mail, color: 'bg-red-500' },
  { type: 'condition', label: 'Condition', icon: Settings, color: 'bg-gray-500' },
  { type: 'webhook', label: 'HTTP Request', icon: Webhook, color: 'bg-indigo-500' },
];

export function AgentBuilderSidebar({
  agentName,
  setAgentName,
  agentDescription,
  setAgentDescription,
  flowDescription,
  setFlowDescription,
  isGenerating,
  isExecuting,
  isEditing,
  onGenerateFlow,
  onClearFlow,
  onSaveAgent,
  onPreviewMode,
  onExecuteFlow
}: AgentBuilderSidebarProps) {
  const navigate = useNavigate();
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <Sidebar className={collapsed ? "w-14" : "w-80"} collapsible="icon">
      <SidebarHeader className="border-b p-4">
        {!collapsed && (
          <>
            <Button 
              variant="ghost" 
              onClick={() => navigate("/")}
              className="justify-start mb-4"
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
          </>
        )}
      </SidebarHeader>

      <SidebarContent>
        {!collapsed && (
          <>
            {/* AI Flow Generator */}
            <SidebarGroup>
              <SidebarGroupLabel className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-500" />
                AI Flödes-Generator
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <div className="space-y-4 px-2">
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
                      onClick={onGenerateFlow} 
                      className="flex-1 gradient-primary shadow-primary"
                      disabled={isGenerating}
                      size="sm"
                    >
                      {isGenerating ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Genererar...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4 mr-2" />
                          Skapa med AI
                        </>
                      )}
                    </Button>
                    <Button 
                      onClick={onClearFlow} 
                      variant="outline"
                      disabled={isGenerating}
                      size="sm"
                    >
                      Rensa
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    💡 AI skapar ett komplett flöde som du sedan kan granska och justera
                  </div>
                </div>
              </SidebarGroupContent>
            </SidebarGroup>

            {/* Node Toolbox */}
            <SidebarGroup>
              <SidebarGroupLabel>Moduler</SidebarGroupLabel>
              <SidebarGroupContent>
                <div className="space-y-2 px-2">
                  <div className="text-xs font-medium text-muted-foreground mb-2">
                    Triggers
                  </div>
                  {nodeTypes.filter(node => node.type === 'trigger').map((node, index) => {
                    const IconComponent = node.icon;
                    return (
                      <div
                        key={`${node.type}-${index}`}
                        className="flex items-center gap-3 p-3 border rounded-lg cursor-move hover:bg-muted/50 transition-colors"
                        draggable
                        onDragStart={(e) => onDragStart(e, node.type)}
                      >
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${node.color}`}>
                          <IconComponent className="w-4 h-4 text-white" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{node.label}</div>
                          <Badge variant="secondary" className="text-xs mt-1">
                            {node.type}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}

                  <div className="text-xs font-medium text-muted-foreground mb-2 mt-4">
                    Actions
                  </div>
                  {nodeTypes.filter(node => node.type !== 'trigger').map((node, index) => {
                    const IconComponent = node.icon;
                    return (
                      <div
                        key={`${node.type}-${index}`}
                        className="flex items-center gap-3 p-3 border rounded-lg cursor-move hover:bg-muted/50 transition-colors"
                        draggable
                        onDragStart={(e) => onDragStart(e, node.type)}
                      >
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${node.color}`}>
                          <IconComponent className="w-4 h-4 text-white" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{node.label}</div>
                          <Badge variant="secondary" className="text-xs mt-1">
                            {node.type}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SidebarGroupContent>
            </SidebarGroup>

            {/* Action Buttons */}
            <SidebarGroup>
              <SidebarGroupContent>
                <div className="space-y-2 px-2">
                  <Button onClick={onSaveAgent} className="w-full" variant="outline" size="sm">
                    <Save className="w-4 h-4 mr-2" />
                    {isEditing ? 'Uppdatera Agent' : 'Spara Agent'}
                  </Button>
                  <Button onClick={onPreviewMode} className="w-full" variant="outline" size="sm">
                    <Eye className="w-4 h-4 mr-2" />
                    Förhandsgranska
                  </Button>
                  <Button 
                    onClick={onExecuteFlow} 
                    className="w-full gradient-primary shadow-primary"
                    disabled={isExecuting || isGenerating}
                    size="sm"
                  >
                    <Play className="w-4 h-4 mr-2" />
                    {isExecuting ? "Kör..." : "Kör Agent"}
                  </Button>
                </div>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>
    </Sidebar>
  );
}