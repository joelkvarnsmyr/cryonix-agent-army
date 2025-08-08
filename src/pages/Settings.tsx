import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { 
  User, 
  Bell, 
  Shield, 
  Key, 
  Palette, 
  Database,
  Download,
  Trash2,
  Save,
  AlertTriangle
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const Settings = () => {
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  
  const [settings, setSettings] = useState({
    // Profile
    displayName: user?.user_metadata?.display_name || "",
    email: user?.email || "",
    
    // Notifications
    emailNotifications: true,
    pushNotifications: false,
    tradingAlerts: true,
    
    // Privacy & Security
    twoFactorAuth: false,
    sessionTimeout: "24",
    
    // API Keys
    openaiKey: "",
    binanceKey: "",
    
    // Theme
    darkMode: true,
    language: "sv",
  });

  const handleSave = () => {
    // Save settings logic here
    toast({
      title: "Inställningar sparade",
      description: "Dina inställningar har uppdaterats.",
    });
  };

  const handleExportData = () => {
    toast({
      title: "Export startad",
      description: "Din data exporteras och skickas till din email.",
    });
  };

  const handleDeleteAccount = async () => {
    try {
      // Delete account logic here
      await signOut();
      toast({
        title: "Konto raderat",
        description: "Ditt konto har raderats permanent.",
      });
    } catch (error) {
      toast({
        title: "Fel",
        description: "Kunde inte radera kontot.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen bg-background">
    
    <main className="pt-6 container mx-auto px-6 pb-8 max-w-4xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Inställningar</h1>
          <p className="text-muted-foreground">Hantera ditt konto och appinställningar</p>
        </div>

        <div className="space-y-6">
          {/* Profile Settings */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                Profil
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="displayName">Visningsnamn</Label>
                  <Input
                    id="displayName"
                    value={settings.displayName}
                    onChange={(e) => setSettings({...settings, displayName: e.target.value})}
                  />
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    value={settings.email}
                    disabled
                    className="bg-muted"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Notifications */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                Notifikationer
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Email-notifikationer</Label>
                  <p className="text-sm text-muted-foreground">Få uppdateringar via email</p>
                </div>
                <Switch
                  checked={settings.emailNotifications}
                  onCheckedChange={(checked) => setSettings({...settings, emailNotifications: checked})}
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <Label>Push-notifikationer</Label>
                  <p className="text-sm text-muted-foreground">Få notifikationer i webbläsaren</p>
                </div>
                <Switch
                  checked={settings.pushNotifications}
                  onCheckedChange={(checked) => setSettings({...settings, pushNotifications: checked})}
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <Label>Trading-varningar</Label>
                  <p className="text-sm text-muted-foreground">Få varningar för stora förändringar</p>
                </div>
                <Switch
                  checked={settings.tradingAlerts}
                  onCheckedChange={(checked) => setSettings({...settings, tradingAlerts: checked})}
                />
              </div>
            </CardContent>
          </Card>

          {/* Security */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Säkerhet
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Tvåfaktorsautentisering</Label>
                  <p className="text-sm text-muted-foreground">Extra säkerhet för ditt konto</p>
                </div>
                <Switch
                  checked={settings.twoFactorAuth}
                  onCheckedChange={(checked) => setSettings({...settings, twoFactorAuth: checked})}
                />
              </div>
              <Separator />
              <div>
                <Label htmlFor="sessionTimeout">Session timeout (timmar)</Label>
                <Input
                  id="sessionTimeout"
                  type="number"
                  value={settings.sessionTimeout}
                  onChange={(e) => setSettings({...settings, sessionTimeout: e.target.value})}
                  className="w-32 mt-1"
                />
              </div>
            </CardContent>
          </Card>

          {/* API Keys */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                API-nycklar
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="openaiKey">OpenAI API-nyckel</Label>
                <Input
                  id="openaiKey"
                  type="password"
                  placeholder="sk-..."
                  value={settings.openaiKey}
                  onChange={(e) => setSettings({...settings, openaiKey: e.target.value})}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Krävs för AI-funktionalitet
                </p>
              </div>
              <div>
                <Label htmlFor="binanceKey">Binance API-nyckel</Label>
                <Input
                  id="binanceKey"
                  type="password"
                  placeholder="Binance API key..."
                  value={settings.binanceKey}
                  onChange={(e) => setSettings({...settings, binanceKey: e.target.value})}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  För kryptovaluta-trading
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Theme & Language */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Palette className="h-5 w-5" />
                Utseende
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Mörkt tema</Label>
                  <p className="text-sm text-muted-foreground">Använd mörkt utseende</p>
                </div>
                <Switch
                  checked={settings.darkMode}
                  onCheckedChange={(checked) => setSettings({...settings, darkMode: checked})}
                />
              </div>
            </CardContent>
          </Card>

          {/* Data Management */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Data & Konto
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Exportera data</Label>
                  <p className="text-sm text-muted-foreground">Ladda ner all din data</p>
                </div>
                <Button variant="outline" onClick={handleExportData}>
                  <Download className="w-4 h-4 mr-2" />
                  Exportera
                </Button>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-destructive">Radera konto</Label>
                  <p className="text-sm text-muted-foreground">Permanent radering av ditt konto</p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive">
                      <Trash2 className="w-4 h-4 mr-2" />
                      Radera
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="flex items-center gap-2">
                        <AlertTriangle className="w-5 h-5 text-destructive" />
                        Radera konto permanent
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Detta kommer att radera ditt konto och all associerad data permanent. 
                        Denna åtgärd kan inte ångras. Alla dina agenter, inställningar och 
                        historik kommer att försvinna för alltid.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Avbryt</AlertDialogCancel>
                      <AlertDialogAction 
                        onClick={handleDeleteAccount}
                        className="bg-destructive hover:bg-destructive/90"
                      >
                        Ja, radera mitt konto
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>

          {/* Save Button */}
          <div className="flex justify-end">
            <Button onClick={handleSave} className="gradient-primary shadow-primary">
              <Save className="w-4 h-4 mr-2" />
              Spara alla inställningar
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Settings;