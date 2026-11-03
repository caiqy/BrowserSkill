/** Desired control is independent of a debugger attachment (which Chrome can drop).
 * Serialize toggles per tab so a late enable cannot outlive its last owner. */
export class BackgroundExecution {
  private readonly owners = new Map<number, Set<string>>();
  private readonly scopedOwners = new Map<number, Map<string, string>>();
  private readonly applied = new Map<number, { attachment: string; enabled: boolean | null }>();
  private readonly pending = new Map<number, Promise<void>>();

  constructor(
    private readonly attachment: (tabId: number) => string | undefined,
    private readonly toggle: (
      tabId: number,
      enabled: boolean,
      onDispatch: () => void,
    ) => Promise<boolean>,
  ) {}

  retain(sessionId: string, tabId: number, attachment?: string): void {
    if (attachment) {
      const scopes = this.scopedOwners.get(tabId) ?? new Map<string, string>();
      scopes.set(sessionId, attachment);
      this.scopedOwners.set(tabId, scopes);
    }
    const owners = this.owners.get(tabId) ?? new Set<string>();
    owners.add(sessionId);
    this.owners.set(tabId, owners);
  }

  hasOwners(tabId: number): boolean {
    return this.owners.has(tabId);
  }

  has(sessionId: string, tabId: number): boolean {
    return this.owners.get(tabId)?.has(sessionId) ?? false;
  }

  release(sessionId: string, tabId: number): void {
    const scopes = this.scopedOwners.get(tabId);
    scopes?.delete(sessionId);
    if (scopes?.size === 0) this.scopedOwners.delete(tabId);
    const owners = this.owners.get(tabId);
    owners?.delete(sessionId);
    if (owners?.size === 0) this.owners.delete(tabId);
  }

  forget(tabId: number): void {
    this.owners.delete(tabId);
    this.scopedOwners.delete(tabId);
    this.applied.delete(tabId);
  }

  invalidate(tabId: number): void {
    for (const owner of this.scopedOwners.get(tabId)?.keys() ?? []) this.release(owner, tabId);
    this.applied.delete(tabId);
  }

  clear(): void {
    this.owners.clear();
    this.scopedOwners.clear();
    this.applied.clear();
  }

  /** Resend an owned override that Chrome dropped without a detach. Never forces a disable. */
  reapply(tabId: number): Promise<void> {
    return this.synchronize(tabId, true);
  }

  async synchronize(tabId: number, reapply = false, toggle = this.toggle): Promise<void> {
    // Keep raw commands serialized across detach/reattach as well. Invalidating
    // applied state does not cancel an issued Chrome command.
    // Join the preceding toggle, but retry a failed toggle on a subsequent call.
    const previous = this.pending.get(tabId);
    const initialAttachment = this.attachment(tabId);
    const next = (async () => {
      await previous?.catch(() => {});
      if (this.attachment(tabId) !== initialAttachment) return;
      // Keep the applied record while reapplying: if the resend fails, release must still disable.
      let force = reapply;
      for (;;) {
        const attachment = this.attachment(tabId);
        if (!attachment) return;
        for (const [owner, original] of this.scopedOwners.get(tabId) ?? [])
          if (original !== attachment) this.release(owner, tabId);
        const enabled = this.owners.has(tabId);
        const applied = this.applied.get(tabId);
        if (
          applied?.attachment === attachment &&
          applied.enabled === enabled &&
          !(force && enabled)
        )
          return;
        if (!enabled && applied?.attachment !== attachment) return;
        // Passive reads cannot restore an unconfirmed request-scoped override.
        if (
          enabled &&
          toggle === this.toggle &&
          [...(this.owners.get(tabId) ?? [])].every((owner) =>
            this.scopedOwners.get(tabId)?.has(owner),
          )
        )
          return;
        force = false;
        let dispatched = false;
        try {
          if (
            !(await toggle(tabId, enabled, () => {
              dispatched = true;
            }))
          )
            return;
        } catch (error) {
          // Either toggle may have applied before its reply failed. Unknown requires cleanup,
          // but cannot satisfy a later owner's enable request.
          if (dispatched && this.attachment(tabId) === attachment)
            this.applied.set(tabId, { attachment, enabled: null });
          throw error;
        }
        if (this.attachment(tabId) !== attachment) {
          throw new Error("Background execution attachment changed during setup");
        }
        this.applied.set(tabId, { attachment, enabled });
        // A release may have arrived while Chrome processed the toggle.
      }
    })();
    this.pending.set(tabId, next);
    try {
      await next;
    } finally {
      if (this.pending.get(tabId) === next) this.pending.delete(tabId);
    }
  }
}
