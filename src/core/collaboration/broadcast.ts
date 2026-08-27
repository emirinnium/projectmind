import type { IntentBroadcast, ConflictPrediction } from './types.js';

export class IntentBroadcastService {
  private subscribers = new Map<string, Array<(broadcast: IntentBroadcast) => void>>();
  private activeIntents = new Map<string, IntentBroadcast[]>(); // agentId -> broadcasts

  broadcastIntent(broadcast: IntentBroadcast): void {
    // Store in-memory for conflict prediction
    const list = this.activeIntents.get(broadcast.agentId) ?? [];
    list.push(broadcast);
    this.activeIntents.set(broadcast.agentId, list);

    // Notify subscribers
    for (const [agentId, callbacks] of this.subscribers) {
      if (agentId === broadcast.agentId) continue; // don't notify self
      for (const cb of callbacks) {
        try {
          cb(broadcast);
        } catch {
          // ignore subscriber errors
        }
      }
    }
  }

  subscribeToIntents(agentId: string, callback: (broadcast: IntentBroadcast) => void): () => void {
    if (!this.subscribers.has(agentId)) {
      this.subscribers.set(agentId, []);
    }
    const list = this.subscribers.get(agentId)!;
    list.push(callback);
    return () => {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  checkConflict(agentId: string, targetFiles: string[]): ConflictPrediction {
    const conflicts: string[] = [];
    const conflictingAgents: string[] = [];
    const conflictingFiles: string[] = [];

    for (const [otherAgentId, broadcasts] of this.activeIntents) {
      if (otherAgentId === agentId) continue;
      for (const b of broadcasts) {
        if (b.intentType === 'read') continue; // read-only doesn't conflict
        for (const f of targetFiles) {
          if (b.targetFiles.includes(f)) {
            if (!conflictingAgents.includes(otherAgentId)) {
              conflictingAgents.push(otherAgentId);
            }
            if (!conflictingFiles.includes(f)) {
              conflictingFiles.push(f);
            }
            if (!conflicts.includes(`${otherAgentId}:${f}`)) {
              conflicts.push(`${otherAgentId}:${f}`);
            }
          }
        }
      }
    }

    const hasConflict = conflictingAgents.length > 0;
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (hasConflict) {
      const writeCount = conflictingAgents.length;
      riskLevel = writeCount >= 2 ? 'high' : 'medium';
    }

    const reasons: string[] = [];
    if (hasConflict) {
      for (const a of conflictingAgents) {
        reasons.push(`Agent ${a} has write/refactor/delete intent on overlapping files.`);
      }
    } else {
      reasons.push('No overlapping write intents detected.');
    }

    return {
      hasConflict,
      conflictingAgents,
      conflictingFiles,
      riskLevel,
      reasons,
    };
  }

  clearIntents(agentId?: string): void {
    if (agentId) {
      this.activeIntents.delete(agentId);
    } else {
      this.activeIntents.clear();
    }
  }
}
