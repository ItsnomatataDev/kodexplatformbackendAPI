// A bounded first line of defence, not a substitute for the production gateway.
// Fixed windows bound memory and database admissions even under source-IP churn.
export class IngressLimiter {
  private window = -1;
  private peers = new Map<string, number>();
  private admitted = 0;
  private rejected = 0;
  private active = 0;
  enter(peer: string, now: number) {
    const window = Math.floor(now / 60000);
    if (window !== this.window) {
      if (this.rejected)
        console.info(
          JSON.stringify({
            event: 'infrastructure.ingress.suppressed',
            count: this.rejected,
            window: this.window,
          }),
        );
      this.window = window;
      this.peers.clear();
      this.admitted = 0;
      this.rejected = 0;
    }
    const count = this.peers.get(peer) ?? 0;
    if (
      this.active >= 16 ||
      this.admitted >= 600 ||
      count >= 120 ||
      (!this.peers.has(peer) && this.peers.size >= 600)
    ) {
      this.rejected++;
      return { allowed: false, report: this.rejected === 1, release: () => {} };
    }
    this.peers.set(peer, count + 1);
    this.admitted++;
    this.active++;
    return {
      allowed: true,
      report: false,
      release: () => {
        this.active--;
      },
    };
  }
}
