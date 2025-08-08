import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bot, Zap, Settings, BarChart3, Plus, LogOut, User } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";

const Navigation = () => {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
    }
  }, [user, loading, navigate]);

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  if (!user) {
    return null;
  }

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass border-b">
      <div className="container mx-auto px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center space-x-3">
            <div className="relative">
              <div className="w-8 h-8 gradient-primary rounded-lg flex items-center justify-center shadow-primary">
                <Bot className="w-5 h-5 text-white" />
              </div>
            </div>
            <div>
              <h1 className="text-xl font-bold">Cryonix</h1>
              <p className="text-xs text-muted-foreground">Agent Platform</p>
            </div>
          </div>

          {/* Navigation Links */}
          <div className="hidden md:flex items-center space-x-6">
            <a href="#dashboard" className="text-sm font-medium hover:text-primary transition-smooth">
              Dashboard
            </a>
            <a href="#agents" className="text-sm font-medium hover:text-primary transition-smooth">
              Agents
            </a>
            <a href="#marketplace" className="text-sm font-medium hover:text-primary transition-smooth">
              Marketplace
            </a>
            <a href="#analytics" className="text-sm font-medium hover:text-primary transition-smooth">
              Analytics
            </a>
          </div>

          {/* Actions */}
          <div className="flex items-center space-x-3">
            <Badge variant="secondary" className="hidden sm:flex">
              <Zap className="w-3 h-3 mr-1" />
              5 Active
            </Badge>
            <Button variant="ghost" size="sm">
              <User className="w-4 h-4 mr-2" />
              {user?.email?.split('@')[0]}
            </Button>
            <Button variant="outline" size="sm">
              <Settings className="w-4 h-4" />
            </Button>
            <Button size="sm" className="gradient-primary shadow-primary">
              <Plus className="w-4 h-4 mr-2" />
              New Agent
            </Button>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navigation;