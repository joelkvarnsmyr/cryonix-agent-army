import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Bot, Zap, Brain, Shield } from "lucide-react";

const HeroSection = () => {
  return (
    <section className="relative overflow-hidden pt-24 pb-16">
      {/* Background Effects */}
      <div className="absolute inset-0 bg-grid-pattern opacity-5"></div>
      <div className="absolute top-20 left-20 w-72 h-72 gradient-primary rounded-full opacity-10 blur-3xl"></div>
      <div className="absolute bottom-20 right-20 w-72 h-72 gradient-accent rounded-full opacity-10 blur-3xl"></div>
      
      <div className="container relative mx-auto px-6">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <Badge variant="secondary" className="mb-6 px-4 py-2">
            <Zap className="w-4 h-4 mr-2" />
            Next-Generation AI Agent Platform
          </Badge>

          {/* Headlines */}
          <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight">
            Din armé av
            <span className="gradient-primary bg-clip-text text-transparent"> AI-agenter</span>
          </h1>
          
          <p className="text-xl md:text-2xl text-muted-foreground mb-8 max-w-3xl mx-auto leading-relaxed">
            Skapa, hantera och kör autonoma AI-agenter som utför verkliga uppgifter. 
            Från day trading till kalendermanagement – automatisera ditt liv.
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-12">
            <Button size="lg" className="gradient-primary shadow-primary text-lg px-8 py-4">
              Kom igång gratis
              <ArrowRight className="w-5 h-5 ml-2" />
            </Button>
            <Button variant="outline" size="lg" className="text-lg px-8 py-4">
              Se demo
            </Button>
          </div>

          {/* Features Grid */}
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            <div className="glass rounded-2xl p-6 transition-smooth hover:scale-105">
              <Bot className="w-8 h-8 text-primary mb-4 mx-auto" />
              <h3 className="font-semibold mb-2">Agent Builder</h3>
              <p className="text-sm text-muted-foreground">Skapa smarta agenter med GUI eller kod</p>
            </div>
            
            <div className="glass rounded-2xl p-6 transition-smooth hover:scale-105">
              <Brain className="w-8 h-8 text-accent mb-4 mx-auto" />
              <h3 className="font-semibold mb-2">LLM Integration</h3>
              <p className="text-sm text-muted-foreground">GPT-5, Claude, och fler AI-modeller</p>
            </div>
            
            <div className="glass rounded-2xl p-6 transition-smooth hover:scale-105">
              <Shield className="w-8 h-8 text-success mb-4 mx-auto" />
              <h3 className="font-semibold mb-2">Säker & Kontrollerad</h3>
              <p className="text-sm text-muted-foreground">Fullständig kontroll över agenternas rättigheter</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;