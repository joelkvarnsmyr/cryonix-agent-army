'use client';

import { useState, useEffect, useRef } from 'react';
import { Bell, AlertTriangle, Info, AlertCircle, Zap, X } from 'lucide-react';
import { Button } from '@cryonix/ui';
import { useWebSocket } from '@/hooks/use-websocket';
import type { WSAlertData, WSTradeData } from '@cryonix/types';

interface Notification {
  id: string;
  type: 'alert' | 'trade';
  level: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
}

function alertToNotification(alert: WSAlertData): Notification {
  return {
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'alert',
    level: alert.level,
    title: alert.source ? `[${alert.source}]` : 'System Alert',
    message: alert.message,
    timestamp: Date.now(),
    read: false,
  };
}

function tradeToNotification(trade: WSTradeData): Notification {
  return {
    id: `trade-${trade.orderId}`,
    type: 'trade',
    level: trade.status === 'failed' ? 'error' : 'info',
    title: `Trade ${trade.status === 'filled' ? 'Executed' : trade.status === 'failed' ? 'Failed' : 'Partial'}`,
    message: `${trade.side.toUpperCase()} ${trade.quantity} ${trade.symbol} @ $${trade.price.toFixed(2)}`,
    timestamp: trade.timestamp || Date.now(),
    read: false,
  };
}

const levelIcon = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
  critical: Zap,
};

const levelColor = {
  info: 'text-blue-400',
  warning: 'text-amber-400',
  error: 'text-red-400',
  critical: 'text-red-500',
};

export function NotificationCenter() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { alerts, trades } = useWebSocket();
  const prevAlertCount = useRef(0);
  const prevTradeCount = useRef(0);

  // Track new alerts
  useEffect(() => {
    if (alerts.length > prevAlertCount.current) {
      const newAlerts = alerts.slice(0, alerts.length - prevAlertCount.current);
      setNotifications((prev) => [
        ...newAlerts.map(alertToNotification),
        ...prev,
      ].slice(0, 50));
    }
    prevAlertCount.current = alerts.length;
  }, [alerts]);

  // Track new trades
  useEffect(() => {
    if (trades.length > prevTradeCount.current) {
      const newTrades = trades.slice(0, trades.length - prevTradeCount.current);
      setNotifications((prev) => [
        ...newTrades.map(tradeToNotification),
        ...prev,
      ].slice(0, 50));
    }
    prevTradeCount.current = trades.length;
  }, [trades]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const clearAll = () => {
    setNotifications([]);
    setOpen(false);
  };

  return (
    <div className="relative" ref={panelRef}>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 relative"
        onClick={() => {
          setOpen(!open);
          if (!open) markAllRead();
        }}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Bell className="h-3.5 w-3.5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-3.5 min-w-[14px] rounded-full bg-red-500 text-[8px] font-bold text-white flex items-center justify-center px-0.5">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 rounded-lg border border-border/40 bg-card/95 backdrop-blur-xl shadow-2xl z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
            <span className="text-xs font-semibold text-foreground">Notifications</span>
            <div className="flex items-center gap-1">
              {notifications.length > 0 && (
                <button
                  onClick={clearAll}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/30"
                >
                  Clear all
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded hover:bg-muted/30"
                aria-label="Close notifications"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="max-h-[320px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="text-center py-8">
                <Bell className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No notifications yet</p>
                <p className="text-[10px] text-muted-foreground/50 mt-1">
                  Alerts and trade events will appear here
                </p>
              </div>
            ) : (
              notifications.map((n) => {
                const Icon = levelIcon[n.level];
                return (
                  <div
                    key={n.id}
                    className={`px-3 py-2.5 border-b border-border/20 hover:bg-muted/20 transition-colors ${
                      !n.read ? 'bg-primary/[0.03]' : ''
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${levelColor[n.level]}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-medium text-foreground/90 truncate">
                          {n.title}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                          {n.message}
                        </p>
                        <p className="text-[9px] text-muted-foreground/40 font-mono mt-1">
                          {new Date(n.timestamp).toLocaleTimeString('sv-SE', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
