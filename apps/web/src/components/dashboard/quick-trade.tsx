"use client";

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Button, Slider } from '@cryonix/ui';

export function QuickTrade() {
  const [riskPercent, setRiskPercent] = useState(2);
  const [positionSize, setPositionSize] = useState(0.1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>⚡ Quick Trade</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-sm font-medium">Asset</label>
          <div className="text-2xl font-bold mt-1">BTC/USDT</div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="bg-muted rounded p-2">
            <div className="text-muted-foreground">Entry</div>
            <div className="font-semibold mt-1">$96,500</div>
          </div>
          <div className="bg-muted rounded p-2">
            <div className="text-muted-foreground">Target</div>
            <div className="font-semibold mt-1 text-green-500">$98,500</div>
          </div>
          <div className="bg-muted rounded p-2">
            <div className="text-muted-foreground">Stop</div>
            <div className="font-semibold mt-1 text-red-500">$95,000</div>
          </div>
        </div>

        <div>
          <label className="text-sm font-medium mb-2 block">
            Position Risk: {riskPercent}%
          </label>
          <Slider
            value={[riskPercent]}
            onValueChange={(val) => setRiskPercent(val[0])}
            max={5}
            step={0.5}
            className="mb-2"
          />
          <div className="text-xs text-muted-foreground">
            Position Size: {positionSize.toFixed(4)} BTC
          </div>
        </div>

        <div className="bg-muted rounded-lg p-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Max Loss:</span>
            <span className="text-red-500 font-semibold">-$300</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Potential Profit:</span>
            <span className="text-green-500 font-semibold">+$400</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">R:R Ratio:</span>
            <span className="font-semibold">1:1.33</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button className="bg-green-600 hover:bg-green-700 w-full">
            🚀 BUY LONG
          </Button>
          <Button variant="outline" className="w-full">
            👁️ PREVIEW
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
