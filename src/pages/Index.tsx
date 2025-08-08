import Navigation from "@/components/layout/Navigation";
import HeroSection from "@/components/dashboard/HeroSection";
import StatsOverview from "@/components/dashboard/StatsOverview";
import AgentGrid from "@/components/dashboard/AgentGrid";

const Index = () => {
  return (
    <div className="min-h-screen">
      <Navigation />
      <main>
        <HeroSection />
        <StatsOverview />
        <AgentGrid />
      </main>
    </div>
  );
};

export default Index;
