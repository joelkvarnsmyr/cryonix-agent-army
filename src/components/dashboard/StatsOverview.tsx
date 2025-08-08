import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot, TrendingUp, Zap, Clock } from "lucide-react";

const stats = [
  {
    title: "Aktiva Agenter",
    value: "6",
    change: "+2",
    icon: Bot,
    color: "primary"
  },
  {
    title: "Total Performance",
    value: "+18.7%",
    change: "+5.2%",
    icon: TrendingUp,
    color: "success"
  },
  {
    title: "Uppgifter Utförda",
    value: "1,247",
    change: "+89",
    icon: Zap,
    color: "accent"
  },
  {
    title: "Aktiv Tid",
    value: "127h",
    change: "+23h",
    icon: Clock,
    color: "warning"
  }
];

const StatsOverview = () => {
  return (
    <section className="py-16 border-t border-border/50">
      <div className="container mx-auto px-6">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {stats.map((stat, index) => {
            const IconComponent = stat.icon;
            
            return (
              <Card key={index} className="glass transition-smooth hover:scale-105">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium text-muted-foreground">
                      {stat.title}
                    </CardTitle>
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                      <IconComponent className="w-4 h-4 text-primary" />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex items-baseline space-x-2">
                    <div className="text-2xl font-bold">{stat.value}</div>
                    <div className="text-sm text-success">
                      {stat.change}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default StatsOverview;