/** Public quota state intentionally excludes token balances and per-request charges. */
export interface AiQuotaSummary {
  status: 'preview' | 'active' | 'inactive';
  remainingPercent: number | null;
  resetsAt: string | null;
  expiresAt: string | null;
  pending: boolean;
}
