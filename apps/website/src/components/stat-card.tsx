interface StatCardProps {
  label: string;
  value: string | number;
  suffix?: string;
}

export function StatCard({ label, value, suffix }: StatCardProps) {
  return (
    <div className="glass-card rounded-xl p-6 space-y-2">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-3xl font-bold font-mono text-glow-cyan">
        {value}
        {suffix && <span className="text-lg text-muted-foreground ml-1">{suffix}</span>}
      </p>
    </div>
  );
}
