import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { 
  Settings, 
  Bot, 
  TrendingUp, 
  Mail, 
  Clock, 
  Globe, 
  MessageCircle,
  Webhook,
  Save,
  Trash2,
  Key
} from "lucide-react";
import { Node } from '@xyflow/react';

interface NodeConfigPanelProps {
  selectedNode: Node | null;
  onUpdateNode: (nodeId: string, data: any) => void;
  onDeleteNode: (nodeId: string) => void;
}

const NodeConfigPanel = ({ selectedNode, onUpdateNode, onDeleteNode }: NodeConfigPanelProps) => {
  const [nodeData, setNodeData] = useState<any>({});

  useEffect(() => {
    if (selectedNode) {
      setNodeData(selectedNode.data || {});
    }
  }, [selectedNode]);

  const handleSave = () => {
    if (selectedNode) {
      onUpdateNode(selectedNode.id, nodeData);
    }
  };

  const handleDelete = () => {
    if (selectedNode) {
      onDeleteNode(selectedNode.id);
    }
  };

  const updateData = (key: string, value: any) => {
    setNodeData(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const getNodeIcon = (type: string) => {
    switch (type) {
      case 'trigger': return Clock;
      case 'gpt': return Bot;
      case 'binance': return TrendingUp;
      case 'email': return Mail;
      case 'condition': return Settings;
      case 'webhook': return Webhook;
      default: return Settings;
    }
  };

  if (!selectedNode) {
    return (
      <Card className="h-full">
        <CardContent className="flex items-center justify-center h-full text-muted-foreground">
          <div className="text-center">
            <Settings className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>Välj en nod för att konfigurera den</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const IconComponent = getNodeIcon(selectedNode.type);

  return (
    <div className="h-full flex flex-col">
      <Card className="flex-1">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconComponent className="w-5 h-5" />
            {nodeData.label || 'Node Configuration'}
            <Badge variant="secondary" className="ml-auto">
              {selectedNode.type}
            </Badge>
          </CardTitle>
        </CardHeader>
        
        <CardContent className="space-y-6">
          {/* Basic Settings */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="label">Node Name</Label>
              <Input
                id="label"
                value={nodeData.label || ''}
                onChange={(e) => updateData('label', e.target.value)}
                placeholder="Enter node name"
              />
            </div>
          </div>

          {/* Type-specific configurations */}
          {selectedNode.type === 'trigger' && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="triggerType">Trigger Type</Label>
                <Select 
                  value={nodeData.triggerType || 'manual'} 
                  onValueChange={(value) => updateData('triggerType', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="schedule">Schedule</SelectItem>
                    <SelectItem value="webhook">Webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {nodeData.triggerType === 'schedule' && (
                <div>
                  <Label htmlFor="schedule">Schedule (Cron format)</Label>
                  <Input
                    id="schedule"
                    value={nodeData.schedule || ''}
                    onChange={(e) => updateData('schedule', e.target.value)}
                    placeholder="0 */5 * * * (every 5 minutes)"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Exempel: "0 */5 * * *" = varje 5:e minut
                  </p>
                </div>
              )}
              
              {nodeData.triggerType === 'webhook' && (
                <div>
                  <Label htmlFor="webhookUrl">Webhook URL</Label>
                  <Input
                    id="webhookUrl"
                    value={nodeData.webhookUrl || ''}
                    onChange={(e) => updateData('webhookUrl', e.target.value)}
                    placeholder="https://api.example.com/webhook"
                  />
                </div>
              )}
            </div>
          )}

          {selectedNode.type === 'gpt' && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="model">AI Model</Label>
                <Select 
                  value={nodeData.model || 'gpt-4o-mini'} 
                  onValueChange={(value) => updateData('model', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gpt-4o-mini">GPT-4o Mini (Snabb)</SelectItem>
                    <SelectItem value="gpt-4o">GPT-4o (Kraftfull)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <Label htmlFor="prompt">AI Prompt</Label>
                <Textarea
                  id="prompt"
                  value={nodeData.prompt || ''}
                  onChange={(e) => updateData('prompt', e.target.value)}
                  placeholder="Skriv instruktioner för AI:n..."
                  rows={4}
                />
              </div>
              
              <div>
                <Label htmlFor="temperature">Temperature ({nodeData.temperature || 0.7})</Label>
                <Input
                  id="temperature"
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={nodeData.temperature || 0.7}
                  onChange={(e) => updateData('temperature', parseFloat(e.target.value))}
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Fokuserad</span>
                  <span>Kreativ</span>
                </div>
              </div>
              
              <div>
                <Label htmlFor="maxTokens">Max Tokens</Label>
                <Input
                  id="maxTokens"
                  type="number"
                  value={nodeData.maxTokens || 1000}
                  onChange={(e) => updateData('maxTokens', parseInt(e.target.value))}
                  placeholder="1000"
                />
              </div>
            </div>
          )}

          {selectedNode.type === 'binance' && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="action">Trading Action</Label>
                <Select 
                  value={nodeData.action || 'get_price'} 
                  onValueChange={(value) => updateData('action', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="get_price">Get Price</SelectItem>
                    <SelectItem value="get_balance">Get Balance</SelectItem>
                    <SelectItem value="buy_sell">Buy/Sell</SelectItem>
                    <SelectItem value="autonomous_trading">Autonomous Trading</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <Label htmlFor="symbols">Trading Symbols</Label>
                <Input
                  id="symbols"
                  value={nodeData.symbols?.join(',') || 'BTCUSDT,ETHUSDT'}
                  onChange={(e) => updateData('symbols', e.target.value.split(',').map(s => s.trim()))}
                  placeholder="BTCUSDT,ETHUSDT,ADAUSDT"
                />
              </div>
              
              <div className="border rounded p-3 bg-muted/50">
                <div className="flex items-center gap-2 mb-2">
                  <Key className="w-4 h-4" />
                  <Label>API Configuration</Label>
                </div>
                <div className="space-y-2">
                  <div>
                    <Label htmlFor="apiKey">Binance API Key</Label>
                    <Input
                      id="apiKey"
                      type="password"
                      value={nodeData.apiKey || ''}
                      onChange={(e) => updateData('apiKey', e.target.value)}
                      placeholder="Your Binance API Key"
                    />
                  </div>
                  <div>
                    <Label htmlFor="apiSecret">Binance API Secret</Label>
                    <Input
                      id="apiSecret"
                      type="password"
                      value={nodeData.apiSecret || ''}
                      onChange={(e) => updateData('apiSecret', e.target.value)}
                      placeholder="Your Binance API Secret"
                    />
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch 
                      id="testnet"
                      checked={nodeData.testnet || true}
                      onCheckedChange={(checked) => updateData('testnet', checked)}
                    />
                    <Label htmlFor="testnet">Använd Testnet</Label>
                  </div>
                </div>
              </div>
            </div>
          )}

          {selectedNode.type === 'email' && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="emailAction">Email Action</Label>
                <Select 
                  value={nodeData.action || 'send'} 
                  onValueChange={(value) => updateData('action', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="send">Send Email</SelectItem>
                    <SelectItem value="read">Read Email</SelectItem>
                    <SelectItem value="reply">Reply to Email</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {(nodeData.action === 'send' || nodeData.action === 'reply') && (
                <>
                  <div>
                    <Label htmlFor="emailTo">To (Email Address)</Label>
                    <Input
                      id="emailTo"
                      value={nodeData.to || ''}
                      onChange={(e) => updateData('to', e.target.value)}
                      placeholder="recipient@example.com"
                    />
                  </div>
                  
                  <div>
                    <Label htmlFor="emailSubject">Subject</Label>
                    <Input
                      id="emailSubject"
                      value={nodeData.subject || ''}
                      onChange={(e) => updateData('subject', e.target.value)}
                      placeholder="Email subject"
                    />
                  </div>
                  
                  <div>
                    <Label htmlFor="emailBody">Email Body</Label>
                    <Textarea
                      id="emailBody"
                      value={nodeData.body || ''}
                      onChange={(e) => updateData('body', e.target.value)}
                      placeholder="Email content..."
                      rows={4}
                    />
                  </div>
                </>
              )}
              
              <div className="border rounded p-3 bg-muted/50">
                <div className="flex items-center gap-2 mb-2">
                  <Mail className="w-4 h-4" />
                  <Label>Email Provider</Label>
                </div>
                <Select 
                  value={nodeData.provider || 'gmail'} 
                  onValueChange={(value) => updateData('provider', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gmail">Gmail</SelectItem>
                    <SelectItem value="outlook">Outlook</SelectItem>
                    <SelectItem value="smtp">Custom SMTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {selectedNode.type === 'condition' && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="condition">Condition</Label>
                <Input
                  id="condition"
                  value={nodeData.condition || ''}
                  onChange={(e) => updateData('condition', e.target.value)}
                  placeholder="confidence > 80"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Exempel: "price {'>'} 50000", "confidence {'>='} 80", "sentiment === 'positive'"
                </p>
              </div>
              
              <div>
                <Label htmlFor="trueLabel">True Path Label</Label>
                <Input
                  id="trueLabel"
                  value={nodeData.trueLabel || 'True'}
                  onChange={(e) => updateData('trueLabel', e.target.value)}
                  placeholder="True"
                />
              </div>
              
              <div>
                <Label htmlFor="falseLabel">False Path Label</Label>
                <Input
                  id="falseLabel"
                  value={nodeData.falseLabel || 'False'}
                  onChange={(e) => updateData('falseLabel', e.target.value)}
                  placeholder="False"
                />
              </div>
            </div>
          )}

          {selectedNode.type === 'webhook' && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="webhookUrl">Webhook URL</Label>
                <Input
                  id="webhookUrl"
                  value={nodeData.url || ''}
                  onChange={(e) => updateData('url', e.target.value)}
                  placeholder="https://api.example.com/webhook"
                />
              </div>
              
              <div>
                <Label htmlFor="method">HTTP Method</Label>
                <Select 
                  value={nodeData.method || 'POST'} 
                  onValueChange={(value) => updateData('method', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GET">GET</SelectItem>
                    <SelectItem value="POST">POST</SelectItem>
                    <SelectItem value="PUT">PUT</SelectItem>
                    <SelectItem value="DELETE">DELETE</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <Label htmlFor="headers">Headers (JSON)</Label>
                <Textarea
                  id="headers"
                  value={nodeData.headers || '{"Content-Type": "application/json"}'}
                  onChange={(e) => updateData('headers', e.target.value)}
                  placeholder='{"Authorization": "Bearer token"}'
                  rows={3}
                />
              </div>
              
              <div>
                <Label htmlFor="payload">Payload (JSON)</Label>
                <Textarea
                  id="payload"
                  value={nodeData.payload || '{}'}
                  onChange={(e) => updateData('payload', e.target.value)}
                  placeholder='{"data": "value"}'
                  rows={3}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Actions */}
      <div className="p-4 border-t bg-card/50 flex gap-2">
        <Button onClick={handleSave} className="flex-1">
          <Save className="w-4 h-4 mr-2" />
          Spara
        </Button>
        <Button 
          onClick={handleDelete} 
          variant="destructive" 
          className="flex-1"
        >
          <Trash2 className="w-4 h-4 mr-2" />
          Ta bort
        </Button>
      </div>
    </div>
  );
};

export default NodeConfigPanel;