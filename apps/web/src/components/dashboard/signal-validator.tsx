'use client';

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cryonix/ui';
import {
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  Play,
  Ban,
  ThumbsUp,
  ThumbsDown,
  Minus,
} from 'lucide-react';

interface ValidatorVote {
  validator_id: string;
  validator_name: string;
  vote: 'APPROVE' | 'REJECT' | 'ABSTAIN';
  confidence: number;
  reasoning: string;
  checks?: {
    name: string;
    passed: boolean;
    value?: string | number;
    threshold?: string | number;
  }[];
}

interface ValidationResult {
  signal_id: string;
  symbol: string;
  action: 'BUY' | 'SELL' | 'WAIT';
  is_valid: boolean;
  consensus_score: number;
  total_validators: number;
  approvals: number;
  rejections: number;
  abstentions: number;
  votes: ValidatorVote[];
  adjusted_prices?: {
    entry: number;
    target: number;
    stop_loss: number;
  };
  risk_assessment?: {
    position_size: number;
    risk_reward_ratio: number;
    max_loss: number;
  };
  timestamp: string;
}

interface SignalValidatorProps {
  validation?: ValidationResult;
  onExecute?: (validation: ValidationResult) => Promise<void>;
  onReject?: (validation: ValidationResult, reason: string) => Promise<void>;
  loading?: boolean;
}

export function SignalValidator({
  validation,
  onExecute,
  onReject,
  loading = false,
}: SignalValidatorProps) {
  const [executing, setExecuting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [expandedValidator, setExpandedValidator] = useState<string | null>(null);

  const handleExecute = async () => {
    if (!validation || !onExecute) return;
    setExecuting(true);
    try {
      await onExecute(validation);
    } finally {
      setExecuting(false);
    }
  };

  const handleReject = async () => {
    if (!validation || !onReject) return;
    setRejecting(true);
    try {
      await onReject(validation, 'Manual rejection');
    } finally {
      setRejecting(false);
    }
  };

  const getVoteIcon = (vote: ValidatorVote['vote']) => {
    switch (vote) {
      case 'APPROVE':
        return <ThumbsUp className="h-4 w-4 text-green-500" />;
      case 'REJECT':
        return <ThumbsDown className="h-4 w-4 text-red-500" />;
      case 'ABSTAIN':
        return <Minus className="h-4 w-4 text-yellow-500" />;
    }
  };

  const getVoteBadge = (vote: ValidatorVote['vote']) => {
    switch (vote) {
      case 'APPROVE':
        return <Badge className="bg-green-500 text-white">APPROVE</Badge>;
      case 'REJECT':
        return <Badge variant="destructive">REJECT</Badge>;
      case 'ABSTAIN':
        return <Badge variant="secondary">ABSTAIN</Badge>;
    }
  };

  const getStatusIcon = () => {
    if (loading) {
      return <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />;
    }
    if (!validation) {
      return <ShieldQuestion className="h-6 w-6 text-muted-foreground" />;
    }
    return validation.is_valid ? (
      <ShieldCheck className="h-6 w-6 text-green-500" />
    ) : (
      <ShieldAlert className="h-6 w-6 text-red-500" />
    );
  };

  const getConsensusColor = (score: number) => {
    if (score >= 0.7) return 'text-green-500';
    if (score >= 0.5) return 'text-yellow-500';
    return 'text-red-500';
  };

  // Show empty state when no validation
  if (!validation && !loading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            {getStatusIcon()}
            <div>
              <CardTitle>Signal Validator</CardTitle>
              <CardDescription>No signal pending validation</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <ShieldQuestion className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm">Select a signal to validate</p>
            <p className="text-xs mt-1">Validators will check technical, risk, and market conditions</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Loading state
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            {getStatusIcon()}
            <div>
              <CardTitle>Signal Validator</CardTitle>
              <CardDescription>Running validation checks...</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Analyzing signal with multiple validators...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-2">
            {getStatusIcon()}
            <div>
              <CardTitle className="flex items-center gap-2">
                Signal Validation
                <Badge variant={validation!.action === 'BUY' ? 'default' : 'destructive'}>
                  {validation!.action}
                </Badge>
                <Badge variant="outline">{validation!.symbol}</Badge>
              </CardTitle>
              <CardDescription>
                {validation!.is_valid ? 'Signal passed validation' : 'Signal failed validation'}
              </CardDescription>
            </div>
          </div>
          <Badge
            variant={validation!.is_valid ? 'default' : 'destructive'}
            className="text-lg px-3 py-1"
          >
            {validation!.is_valid ? 'VALID' : 'INVALID'}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Consensus Score */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium">Consensus Score</span>
            <span className={`text-lg font-bold ${getConsensusColor(validation!.consensus_score)}`}>
              {(validation!.consensus_score * 100).toFixed(0)}%
            </span>
          </div>
          <Progress
            value={validation!.consensus_score * 100}
            className="h-3"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>0%</span>
            <span>50% (Threshold)</span>
            <span>100%</span>
          </div>
        </div>

        {/* Vote Summary */}
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-center">
            <CheckCircle className="h-5 w-5 text-green-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-green-500">{validation!.approvals}</div>
            <div className="text-xs text-muted-foreground">Approvals</div>
          </div>
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-center">
            <XCircle className="h-5 w-5 text-red-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-red-500">{validation!.rejections}</div>
            <div className="text-xs text-muted-foreground">Rejections</div>
          </div>
          <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-center">
            <AlertCircle className="h-5 w-5 text-yellow-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-yellow-500">{validation!.abstentions}</div>
            <div className="text-xs text-muted-foreground">Abstentions</div>
          </div>
        </div>

        {/* Adjusted Prices */}
        {validation!.adjusted_prices && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Adjusted Prices</h4>
            <div className="grid grid-cols-3 gap-3">
              <div className="p-2 bg-muted rounded">
                <div className="text-xs text-muted-foreground">Entry</div>
                <div className="font-mono font-semibold">
                  ${validation!.adjusted_prices.entry.toFixed(2)}
                </div>
              </div>
              <div className="p-2 bg-muted rounded">
                <div className="text-xs text-muted-foreground">Target</div>
                <div className="font-mono font-semibold text-green-500">
                  ${validation!.adjusted_prices.target.toFixed(2)}
                </div>
              </div>
              <div className="p-2 bg-muted rounded">
                <div className="text-xs text-muted-foreground">Stop Loss</div>
                <div className="font-mono font-semibold text-red-500">
                  ${validation!.adjusted_prices.stop_loss.toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Risk Assessment */}
        {validation!.risk_assessment && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Risk Assessment</h4>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="p-2 bg-muted rounded">
                <div className="text-xs text-muted-foreground">Position Size</div>
                <div className="font-semibold">
                  ${validation!.risk_assessment.position_size.toFixed(2)}
                </div>
              </div>
              <div className="p-2 bg-muted rounded">
                <div className="text-xs text-muted-foreground">Risk/Reward</div>
                <div className="font-semibold">
                  1:{validation!.risk_assessment.risk_reward_ratio.toFixed(1)}
                </div>
              </div>
              <div className="p-2 bg-muted rounded">
                <div className="text-xs text-muted-foreground">Max Loss</div>
                <div className="font-semibold text-red-500">
                  ${validation!.risk_assessment.max_loss.toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Individual Validator Results */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Validator Results</h4>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Validator</TableHead>
                  <TableHead className="w-[100px]">Vote</TableHead>
                  <TableHead className="w-[100px]">Confidence</TableHead>
                  <TableHead>Reasoning</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {validation!.votes.map((vote) => (
                  <TableRow
                    key={vote.validator_id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() =>
                      setExpandedValidator(
                        expandedValidator === vote.validator_id ? null : vote.validator_id
                      )
                    }
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {getVoteIcon(vote.vote)}
                        {vote.validator_name}
                      </div>
                    </TableCell>
                    <TableCell>{getVoteBadge(vote.vote)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Progress value={vote.confidence * 100} className="w-16 h-2" />
                        <span className="text-xs">{(vote.confidence * 100).toFixed(0)}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[300px] truncate">
                      {vote.reasoning}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Expanded Validator Checks */}
        {expandedValidator && (
          <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
            {validation!.votes
              .filter((v) => v.validator_id === expandedValidator && v.checks)
              .map((vote) => (
                <div key={vote.validator_id} className="p-3 bg-muted/50 rounded-lg space-y-2">
                  <h5 className="text-sm font-medium">{vote.validator_name} - Detailed Checks</h5>
                  <div className="space-y-1">
                    {vote.checks?.map((check, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between text-sm py-1 border-b border-border last:border-0"
                      >
                        <div className="flex items-center gap-2">
                          {check.passed ? (
                            <CheckCircle className="h-3 w-3 text-green-500" />
                          ) : (
                            <XCircle className="h-3 w-3 text-red-500" />
                          )}
                          <span>{check.name}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {check.value !== undefined && (
                            <span className="font-mono">{check.value}</span>
                          )}
                          {check.threshold !== undefined && (
                            <span className="ml-1">(threshold: {check.threshold})</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-3 pt-4 border-t">
          <Button
            className="flex-1"
            variant={validation!.is_valid ? 'default' : 'secondary'}
            onClick={handleExecute}
            disabled={executing || rejecting || !validation!.is_valid}
          >
            {executing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Execute Trade
          </Button>
          <Button
            className="flex-1"
            variant="destructive"
            onClick={handleReject}
            disabled={executing || rejecting}
          >
            {rejecting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Ban className="h-4 w-4 mr-2" />
            )}
            Reject Signal
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
