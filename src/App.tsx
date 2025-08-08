import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import Auth from "./pages/Auth";
import AgentBuilder from "./pages/AgentBuilder";
import AgentChat from "./pages/AgentChat";
import AgentCoordinator from "./pages/AgentCoordinator";
import AgentOrchestrator from "./pages/AgentOrchestrator";
import Agents from "./pages/Agents";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";
import Integrations from "./pages/Integrations";
import AppLayout from "./components/layout/AppLayout";
import { Navigate } from "react-router-dom";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AppLayout>
            <Routes>
              <Route path="/" element={<Navigate to="/orchestrator" replace />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/builder" element={<AgentBuilder />} />
              <Route path="/chat" element={<AgentChat />} />
              <Route path="/coordinator" element={<AgentCoordinator />} />
              <Route path="/orchestrator" element={<AgentOrchestrator />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/settings" element={<Settings />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
