"use client";

import { useState, useEffect, useCallback } from 'react';
import { Brain, ShieldAlert, Zap } from 'lucide-react';
import { Card, CardContent } from '@cryonix/ui';

interface AutopilotAction {
  id: number;
  runId: string;
  actionType: string;
  target: string | null;
  oldValue: string | null;
  newValue: string | null;
  reasoning: string | null;
  confidence: string | null;
  applied: boolean;
  createdAt: string | null;
}

interface BrainData {
  actions: AutopilotAction[];
  blocked: string[];
  directives: any;
  acuteTrigger: any;
}

const ACTION_STYLE: Record<string, string> = {
  boost_confidence:   'text-emerald-400',
  reduce_confidence:  'text-red-400',
  block_pattern:      'text-red-400',
  unblock_pattern:    'text-emerald-400',
  adjust_param:       'text-amber-400',
  tighten_sl:         'text-orange-400',
  widen_tp:           'text-cyan-400',
};

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function AiBrainCard() {
  const [data, setData] = useState<BrainData | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/autopilot');
      if (res.ok) setData(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => clearInterval(id);
  }, [fetch_]);

  const actions = data?.actions ?? [];
  const blocked = data?.blocked ?? [];
  const hasAcute = !!data?.acuteTrigger;
  const appliedCount = actions.filter(a => a.applied).length;
  const recentActions = actions.slice(0, 8);

  return (
    <Card className="glass-card overflow-hidden" style={{ boxShadow: '0 0 0 1px rgba(236,72,153,0.12), 0 0 12px rgba(236,72,153,0.04)' }}>
      <CardContent className="p-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-pink-400/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">AI Brain</span>
          </div>
          <div className="flex items-center gap-1.5">
            {hasAcute && (
              <span className="flex items-center gap-0.5 text-[9px] font-mono text-red-400 px-1.5 py-0.5 rounded border border-red-400/25 bg-red-400/5">
                <Zap className="h-2.5 w-2.5" />
                ACUTE
              </span>
            )}
          </div>
        </div>

        {/* Blocked patterns */}
        {blocked.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1">
            {blocked.map(pattern => (
              <span key={pattern} className="flex items-center gap-0.5 text-[9px] font-mono text-red-400/70 px-1.5 py-0.5 rounded bg-red-400/5 border border-red-400/15">
                <ShieldAlert className="h-2.5 w-2.5" />
                {pattern}
              </span>
            ))}
          </div>
        )}

        {/* Recent actions */}
        {recentActions.length === 0 ? (
          <div className="text-sm text-muted-foreground/40 text-center py-2">No autopilot actions yet</div>
        ) : (
          <div className="space-y-1.5">
            {recentActions.map(action => (
              <div key={action.id} className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-[10px] font-mono font-semibold flex-shrink-0 ${ACTION_STYLE[action.actionType] ?? 'text-muted-foreground'}`}>
                    {action.actionType.replace(/_/g, ' ').toUpperCase()}
                  </span>
                  {action.target && (
                    <span className="text-[10px] font-mono text-foreground/60 truncate">
                      {action.target}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`text-[9px] font-mono ${action.applied ? 'text-emerald-400' : 'text-muted-foreground/40'}`}>
                    {action.applied ? '✓' : '✗'}
                  </span>
                  {action.createdAt && (
                    <span className="text-[9px] font-mono text-muted-foreground/30 w-8 text-right">
                      {timeAgo(action.createdAt)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Footer stats */}
        <div className="mt-3 flex items-center justify-between text-[9px] font-mono text-muted-foreground/35">
          <span>{actions.length} actions total</span>
          <span>{appliedCount} applied</span>
        </div>
      </CardContent>
    </Card>
  );
}
