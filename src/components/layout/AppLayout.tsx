import { ReactNode } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { useLocation } from "react-router-dom";

interface AppLayoutProps {
  children: ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const isBuilder = location.pathname.startsWith("/builder");

  // Full-screen mode for the Builder (uses its own layout)
  if (isBuilder) return <>{children}</>;

  return (
    <SidebarProvider>
      <header className="h-12 flex items-center border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-40">
        {/* Global sidebar trigger always visible */}
        <SidebarTrigger className="ml-2" />
        <h1 className="ml-4 font-semibold">Cryonix</h1>
      </header>

      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <main className="flex-1 p-4">{children}</main>
      </div>
    </SidebarProvider>
  );
}
