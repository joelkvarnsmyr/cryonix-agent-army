import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Mail, Calendar, CheckCircle2, XCircle, Plug, LogIn } from "lucide-react";

export default function Integrations() {
  const { session } = useAuth();
  const { toast } = useToast();

  const identities = useMemo(() => session?.user?.identities || [], [session]);
  const hasGoogle = identities.some((i) => i.provider === "google");
  const hasMicrosoft = identities.some((i) => i.provider?.includes("azure"));

  const connect = async (provider: "google" | "azure") => {
    const redirectTo = `${window.location.origin}/integrations`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    if (error) {
      toast({ title: "Fel vid anslutning", description: error.message, variant: "destructive" });
    }
  };

  const disconnectInfo = () => {
    toast({
      title: "Koppla från i kontoinställningar",
      description: "Stöd för att koppla från specifika identiteter kommer snart.",
    });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Plug className="w-5 h-5 text-primary" />
        <h1 className="text-xl font-semibold">Integrationer</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Anslut e‑post, kalender och att‑göra‑listor. Google och Microsoft använder OAuth. iCloud kräver app‑lösenord.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Google */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-4 h-4" /> Gmail / <Calendar className="w-4 h-4" /> Calendar / Tasks
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              {hasGoogle ? (
                <Badge variant="secondary" className="flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-primary" /> Ansluten
                </Badge>
              ) : (
                <Badge variant="outline" className="flex items-center gap-1">
                  <XCircle className="w-3 h-3" /> Ej ansluten
                </Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => connect("google")}>
                <LogIn className="w-4 h-4 mr-2" /> {hasGoogle ? "Återanslut" : "Anslut Google"}
              </Button>
              <Button variant="outline" onClick={disconnectInfo} disabled={!hasGoogle}>
                Koppla från
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Microsoft */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-4 h-4" /> Outlook / <Calendar className="w-4 h-4" /> Calendar / To Do
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              {hasMicrosoft ? (
                <Badge variant="secondary" className="flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-primary" /> Ansluten
                </Badge>
              ) : (
                <Badge variant="outline" className="flex items-center gap-1">
                  <XCircle className="w-3 h-3" /> Ej ansluten
                </Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => connect("azure")}>
                <LogIn className="w-4 h-4 mr-2" /> {hasMicrosoft ? "Återanslut" : "Anslut Microsoft"}
              </Button>
              <Button variant="outline" onClick={disconnectInfo} disabled={!hasMicrosoft}>
                Koppla från
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* iCloud (IMAP/CalDAV via edge-func) */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">iCloud Mail & Calendar (IMAP/CalDAV)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Kräver app‑lösenord. Vi kommer använda en skyddad edge‑funktion för IMAP/CalDAV.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" disabled>
                Kommer snart
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
