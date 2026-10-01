import { randomUUID } from "node:crypto";
import type { ApproveAction, PermissionAction } from "./policy.ts";

export interface PermissionRequest extends PermissionAction {
  id: string;
  runId: string;
  expiresAt: string;
}

interface Pending {
  userId: string;
  request: PermissionRequest;
  finish(approved: boolean): void;
}

export class PermissionManager {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 300_000) {}

  reviewer(userId: string, runId: string, notify: (request: PermissionRequest) => void, resolved: (id: string, approved: boolean) => void): ApproveAction {
    return (action) => new Promise<boolean>((resolve) => {
      const request: PermissionRequest = { ...action, id: randomUUID(), runId, expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() };
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      const finish = (approved: boolean) => {
        if (!this.pending.has(request.id)) return;
        clearTimeout(timer);
        this.pending.delete(request.id);
        resolve(approved);
        resolved(request.id, approved);
      };
      this.pending.set(request.id, { userId, request, finish });
      try { notify(structuredClone(request)); } catch { finish(false); }
    });
  }

  list(userId: string): PermissionRequest[] {
    return [...this.pending.values()].filter((item) => item.userId === userId).map((item) => structuredClone(item.request));
  }

  decide(userId: string, id: string, approved: boolean): boolean {
    const item = this.pending.get(id);
    if (!item || item.userId !== userId) return false;
    if (Date.parse(item.request.expiresAt) <= Date.now()) { item.finish(false); return false; }
    item.finish(approved);
    return true;
  }

  cancelRun(runId: string): void {
    for (const item of this.pending.values()) {
      if (item.request.runId === runId) item.finish(false);
    }
  }
}
