'use client';

import { useMetrics } from '@/hooks/useMetrics';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const TREND_ICON: Record<string, string> = { declining: '\u2193', improving: '\u2191', stable: '\u2192' };
const TREND_COLOR: Record<string, string> = { declining: 'text-red-400', improving: 'text-emerald-400', stable: 'text-muted-foreground/50' };

export default function MetricsPage() {
    const { data, error } = useMetrics(30_000);
    const ecr = data?.edgeCaptureRatio;
    const ad = data?.alphaDecay;
    const kr = data?.killRate;
    const mfs = data?.mutationFitness;
    const cv = data?.capitalVelocity;

    return (
        <DashboardLayout>
            <div className="max-w-4xl mx-auto space-y-4">
                {/* Header */}
                <div className="rounded-lg border border-rose-400/30 bg-rose-400/5 px-4 py-2 flex items-center justify-between">
                    <span className="text-rose-400 text-[10px] font-mono font-bold tracking-widest">EDGE MACHINE — METRICS</span>
                    <span className="text-xs text-muted-foreground/60 font-mono">Live data from /api/metrics</span>
                </div>

                {/* ECR — North Star */}
                <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
                    <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-2">EDGE CAPTURE RATIO</div>
                    <div className={`text-4xl font-bold font-mono ${ecr && ecr.ecr >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {ecr ? `${ecr.ecr.toFixed(2)}%` : '\u2014'}
                    </div>
                    {ecr && (
                        <div className="text-xs text-muted-foreground/40 mt-1 font-mono">
                            realized ${ecr.realized.toFixed(2)} / theoretical ${ecr.theoretical.toFixed(2)} ({ecr.period})
                        </div>
                    )}
                    {data?.ecrHistory && data.ecrHistory.length > 1 && (
                        <div className="h-24 mt-3">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={data.ecrHistory}>
                                    <defs>
                                        <linearGradient id="ecrGrad" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#fb7185" stopOpacity={0.3}/>
                                            <stop offset="95%" stopColor="#fb7185" stopOpacity={0}/>
                                        </linearGradient>
                                    </defs>
                                    <Area type="monotone" dataKey="ecr" stroke="#fb7185" fill="url(#ecrGrad)" strokeWidth={1.5} />
                                    <XAxis dataKey="timestamp" hide />
                                    <YAxis hide domain={['auto', 'auto']} />
                                    <Tooltip
                                        contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11 }}
                                        formatter={(v: number) => [`${v.toFixed(4)}%`, 'ECR']}
                                        labelFormatter={(ts: number) => new Date(ts).toLocaleDateString()}
                                    />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    )}
                </div>

                {/* Row: Kill Rate + Capital Velocity */}
                <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
                        <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">KILL RATE</div>
                        <div className={`text-2xl font-bold font-mono ${kr && kr.killRate > 30 ? 'text-amber-400' : 'text-foreground'}`}>
                            {kr ? `${kr.killRate}%` : '\u2014'}
                        </div>
                        <div className="text-[10px] text-muted-foreground/40 font-mono">
                            {kr ? `${kr.profitable}/${kr.total} profitable rejections` : 'awaiting data (~4h)'}
                        </div>
                    </div>
                    <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
                        <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">CAPITAL VELOCITY</div>
                        <div className="text-2xl font-bold font-mono text-foreground">
                            {cv ? `${cv.velocity.toFixed(2)}x` : '\u2014'}
                        </div>
                        <div className="text-[10px] text-muted-foreground/40 font-mono">
                            {cv ? `${cv.trades} trades, $${cv.volume.toFixed(0)} vol, ${cv.days.toFixed(0)}d` : 'no data'}
                        </div>
                    </div>
                </div>

                {/* Alpha Decay */}
                <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
                    <div className="px-4 py-3 border-b border-white/[0.04]">
                        <h3 className="text-sm font-mono font-bold tracking-wider text-rose-400">ALPHA DECAY</h3>
                    </div>
                    {ad ? (
                        <div className="divide-y divide-white/[0.04]">
                            {Object.entries(ad.patterns)
                                .sort(([,a], [,b]) => a.slope - b.slope)
                                .map(([pattern, d]) => (
                                <div key={pattern} className="px-4 py-2 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className={`text-sm font-mono ${TREND_COLOR[d.trend]}`}>{TREND_ICON[d.trend]}</span>
                                        <span className="text-xs font-mono">{pattern}</span>
                                    </div>
                                    <div className="flex items-center gap-4 text-xs font-mono">
                                        <span className={d.latestEv >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                            EV: {d.latestEv.toFixed(4)}
                                        </span>
                                        <span className="text-muted-foreground/40">
                                            slope: {d.slope.toFixed(4)}
                                        </span>
                                        <span className="text-muted-foreground/30">{d.periods}p</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="p-6 text-center text-sm text-muted-foreground/50">No alpha decay data</div>
                    )}
                </div>

                {/* Mutation Fitness */}
                <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
                    <div className="px-4 py-3 border-b border-white/[0.04]">
                        <h3 className="text-sm font-mono font-bold tracking-wider text-foreground">MUTATION FITNESS</h3>
                    </div>
                    {mfs && mfs.comparisons.length > 0 ? (
                        <div className="divide-y divide-white/[0.04]">
                            {mfs.comparisons.map((c, i) => (
                                <div key={i} className="px-4 py-2 flex items-center justify-between">
                                    <span className="text-xs font-mono text-muted-foreground/60">
                                        {c.from.slice(0,8)} → {c.to.slice(0,8)}
                                    </span>
                                    <span className={`text-sm font-mono font-bold ${c.improved ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {c.improved ? '\u2191' : '\u2193'} {c.deltaSharpe > 0 ? '+' : ''}{c.deltaSharpe.toFixed(3)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="p-6 text-center text-sm text-muted-foreground/50">No mutation data</div>
                    )}
                </div>

                {error && (
                    <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-3 text-xs text-red-400 font-mono">{error}</div>
                )}
            </div>
        </DashboardLayout>
    );
}
