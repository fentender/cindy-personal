export type OrcaDisplayAgentKind = 'claude-code' | 'codex' | 'pi' | 'antigravity';
export type OrcaDisplayVendor = 'cc' | 'codex' | 'pi' | 'antigravity';

export function normalizeOrcaDisplayAgentKind(agentKind: unknown): OrcaDisplayAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'pi') return 'pi';
  if (agentKind === 'antigravity') return 'antigravity';
  if (agentKind === 'cc' || agentKind === 'claude-code') return 'claude-code';
  return 'claude-code';
}

export function orcaAgentLabel(agentKind: OrcaDisplayAgentKind): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : agentKind === 'antigravity' ? 'Antigravity' : 'Claude';
}

export function orcaVendorForAgentKind(agentKind: OrcaDisplayAgentKind): OrcaDisplayVendor {
  return agentKind === 'claude-code' ? 'cc' : agentKind;
}
