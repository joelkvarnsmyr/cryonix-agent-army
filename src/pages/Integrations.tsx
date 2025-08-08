import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Mail, Calendar, CheckCircle2, XCircle, Plug, LogIn, Settings, Loader2 } from "lucide-react";

export default function Integrations() {
  const { session } = useAuth();
  const { toast } = useToast();

  // States for IMAP/SMTP configuration
  const [showImapConfig, setShowImapConfig] = useState(false);
  const [imapConfig, setImapConfig] = useState({
    provider: 'onecom',
    email: '',
    password: '',
    customHost: '',
    customPort: '',
  });
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Gmail fetching state
  const [isFetchingGmail, setIsFetchingGmail] = useState(false);
  const [gmailEmails, setGmailEmails] = useState<Array<{ id: string; from: string; subject: string; date: string; snippet: string }>>([]);

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

  const testImapConnection = async () => {
    setIsTestingConnection(true);
    setConnectionStatus('idle');

    try {
      const requestBody = {
        action: 'test-connection',
        provider: imapConfig.provider,
        email: imapConfig.email,
        password: imapConfig.password,
        customConfig: imapConfig.customHost ? {
          imapHost: imapConfig.customHost,
          imapPort: parseInt(imapConfig.customPort) || 993,
        } : undefined,
      };

      console.log('Testing IMAP connection with:', requestBody);

      const response = await supabase.functions.invoke('email-service', {
        body: requestBody,
      });

      console.log('Raw Supabase response:', response);
      console.log('Response data:', response.data);
      console.log('Response error:', response.error);

      if (response.error) {
        console.error('Supabase error details:', response.error);
        throw new Error(response.error.message || response.error.toString());
      }

      const { data } = response;
      console.log('Response data content:', data);
      
      if (data?.success) {
        setConnectionStatus('success');
        toast({
          title: "Anslutning lyckades!",
          description: `Ansluten till ${data.config?.imapHost || 'email-server'}`,
        });
      } else {
        console.log('Connection failed, data:', data);
        throw new Error(data?.error || data?.message || 'Connection failed');
      }
    } catch (error: any) {
      console.error('Full error details:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      
      setConnectionStatus('error');
      toast({
        title: "Anslutning misslyckades",
        description: error.message || "Kunde inte ansluta till email-servern",
        variant: "destructive",
      });
    } finally {
      setIsTestingConnection(false);
    }
  };

  const disconnectInfo = () => {
    toast({
      title: "Koppla från i kontoinställningar",
      description: "Stöd för att koppla från specifika identiteter kommer snart.",
    });
  };

  const fetchGmailEmails = async (count = 200) => {
    if (!hasGoogle) {
      toast({ title: 'Inte ansluten till Google', description: 'Anslut Google först', variant: 'destructive' });
      return;
    }

    const accessToken = (session as any)?.provider_token as string | undefined;
    if (!accessToken) {
      toast({ title: 'Saknar åtkomsttoken', description: 'Återanslut Google för att hämta token', variant: 'destructive' });
      return;
    }

    try {
      setIsFetchingGmail(true);
      setGmailEmails([]);

      const { data, error } = await supabase.functions.invoke('email-service', {
        body: { action: 'gmail-list', accessToken, maxResults: count },
      });

      if (error) throw error;
      const emails = (data?.emails || []).map((e: any) => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
        snippet: e.body,
      }));
      setGmailEmails(emails);
      toast({ title: 'Hämtat e‑post', description: `Visar ${emails.length} konversationer` });
    } catch (err: any) {
      console.error('Gmail fetch error:', err);
      toast({ title: 'Kunde inte hämta Gmail', description: err.message || String(err), variant: 'destructive' });
    } finally {
      setIsFetchingGmail(false);
    }
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
              <Button 
                variant="secondary" 
                onClick={() => fetchGmailEmails(200)} 
                disabled={!hasGoogle || isFetchingGmail}
              >
                {isFetchingGmail ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Hämtar...
                  </>
                ) : (
                  'Hämta 200 mail'
                )}
              </Button>
            </div>

            {gmailEmails.length > 0 && (
              <div className="mt-2 max-h-64 overflow-auto rounded-md border">
                <ul className="divide-y">
                  {gmailEmails.slice(0, 200).map((m) => (
                    <li key={m.id} className="p-2 text-sm">
                      <div className="flex justify-between">
                        <span className="font-medium">{m.subject}</span>
                        <span className="text-muted-foreground">{new Date(m.date).toLocaleString()}</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{m.from}</div>
                      <div className="text-xs text-muted-foreground truncate">{m.snippet}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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

        {/* IMAP/SMTP */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-4 h-4" />
              IMAP/SMTP Email
              <Badge variant="outline">One.com, Gmail, Outlook</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              {connectionStatus === 'success' ? (
                <Badge variant="secondary" className="flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-primary" /> Testad & Fungerar
                </Badge>
              ) : connectionStatus === 'error' ? (
                <Badge variant="destructive" className="flex items-center gap-1">
                  <XCircle className="w-3 h-3" /> Anslutning misslyckad
                </Badge>
              ) : (
                <Badge variant="outline" className="flex items-center gap-1">
                  <Settings className="w-3 h-3" /> Behöver konfiguration
                </Badge>
              )}
            </div>

            {!showImapConfig ? (
              <div className="flex gap-2">
                <Button onClick={() => setShowImapConfig(true)}>
                  <Settings className="w-4 h-4 mr-2" /> Konfigurera IMAP/SMTP
                </Button>
              </div>
            ) : (
              <div className="space-y-4 p-4 border rounded-lg bg-muted/20">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="provider">Email-leverantör</Label>
                    <Select 
                      value={imapConfig.provider} 
                      onValueChange={(value) => setImapConfig({...imapConfig, provider: value})}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="onecom">One.com</SelectItem>
                        <SelectItem value="gmail">Gmail (App-lösenord krävs)</SelectItem>
                        <SelectItem value="outlook">Outlook</SelectItem>
                        <SelectItem value="imap">Anpassad IMAP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="email">Email-adress</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="din@email.com"
                      value={imapConfig.email}
                      onChange={(e) => setImapConfig({...imapConfig, email: e.target.value})}
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="password">
                    {imapConfig.provider === 'gmail' ? 'App-lösenord' : 'Lösenord'}
                  </Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder={imapConfig.provider === 'gmail' ? 'App-lösenord från Google' : 'Ditt email-lösenord'}
                    value={imapConfig.password}
                    onChange={(e) => setImapConfig({...imapConfig, password: e.target.value})}
                  />
                  {imapConfig.provider === 'gmail' && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Skapa app-lösenord på: myaccount.google.com/apppasswords
                    </p>
                  )}
                </div>

                {imapConfig.provider === 'imap' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="customHost">IMAP Server</Label>
                      <Input
                        id="customHost"
                        placeholder="imap.example.com"
                        value={imapConfig.customHost}
                        onChange={(e) => setImapConfig({...imapConfig, customHost: e.target.value})}
                      />
                    </div>
                    <div>
                      <Label htmlFor="customPort">Port</Label>
                      <Input
                        id="customPort"
                        placeholder="993"
                        value={imapConfig.customPort}
                        onChange={(e) => setImapConfig({...imapConfig, customPort: e.target.value})}
                      />
                    </div>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button 
                    onClick={testImapConnection}
                    disabled={!imapConfig.email || !imapConfig.password || isTestingConnection}
                  >
                    {isTestingConnection ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Testar...
                      </>
                    ) : (
                      'Testa anslutning'
                    )}
                  </Button>
                  <Button variant="outline" onClick={() => setShowImapConfig(false)}>
                    Stäng
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
