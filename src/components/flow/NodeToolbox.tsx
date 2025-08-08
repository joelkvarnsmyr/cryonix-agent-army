import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Bot, 
  TrendingUp, 
  Mail, 
  Globe, 
  GitBranch, 
  Zap,
  Database,
  Calendar,
  FileText,
  MessageSquare
} from "lucide-react";

const nodeCategories = [
  {
    title: "Triggers",
    nodes: [
      { type: "trigger", label: "Manual Trigger", icon: Zap, color: "bg-blue-500" },
      { type: "webhook", label: "Webhook", icon: Globe, color: "bg-green-500" },
    ]
  },
  {
    title: "AI & Logic",
    nodes: [
      { type: "gpt", label: "GPT-5", icon: Bot, color: "bg-purple-500" },
      { type: "condition", label: "Condition", icon: GitBranch, color: "bg-orange-500" },
    ]
  },
  {
    title: "Integrations",
    nodes: [
      { type: "binance", label: "Binance API", icon: TrendingUp, color: "bg-yellow-500" },
      { type: "email", label: "Email", icon: Mail, color: "bg-red-500" },
      { type: "calendar", label: "Calendar", icon: Calendar, color: "bg-indigo-500" },
      { type: "database", label: "Database", icon: Database, color: "bg-gray-500" },
    ]
  }
];

const NodeToolbox = () => {
  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-lg">Moduler</h3>
      
      {nodeCategories.map((category) => (
        <Card key={category.title} className="glass">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{category.title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {category.nodes.map((node) => {
              const IconComponent = node.icon;
              
              return (
                <div
                  key={node.type}
                  className="flex items-center gap-3 p-3 border rounded-lg cursor-grab hover:bg-accent transition-colors"
                  draggable
                  onDragStart={(event) => onDragStart(event, node.type)}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${node.color}`}>
                    <IconComponent className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium">{node.label}</div>
                    <Badge variant="secondary" className="text-xs">
                      {node.type}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
      
      <div className="text-xs text-muted-foreground p-2 bg-muted rounded-lg">
        💡 Dra och släpp moduler till canvas för att bygga din agent
      </div>
    </div>
  );
};

export default NodeToolbox;