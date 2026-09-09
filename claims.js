import { ethers } from 'ethers';
import { isTransientRpcError } from './rpcPool.js';

// claims.js
//
// Tracks epochs you've won but haven't claimed yet, and only sends a claim()
// transaction once the batched reward comfortably covers the transaction's
// own gas cost. Reads (claimable, rounds, ledger, gas estimate, fee data) use
// the RPC pool's failover. The actual claim() transaction does NOT auto-retry
// across endpoints - see rpcPool.js for why - it rotates the pointer for next
// time on a transient failure instead.

export class ClaimManager {
  constructor({ rpcPool, gasBufferMultiplier = 1.5, maxQueueSize = 10, onEvent = () => {} }) {
    this.rpcPool = rpcPool;
    this.gasBufferMultiplier = gasBufferMultiplier;
    this.maxQueueSize = maxQueueSize;
    this.onEvent = onEvent; // optional hook so callers (e.g. a dashboard) see claim activity too
    this.queue = new Set(); // epoch strings believed to be won and unclaimed
  }

  enqueue(epoch) {
    this.queue.add(epoch.toString());
  }

  get queueSize() {
    return this.queue.size;
  }

  async tryClaim() {
    if (this.queue.size === 0) return;

    const epochs = [];
    let totalRewardWei = 0n;

    for (const epochKey of [...this.queue]) {
      const epoch = BigInt(epochKey);
      let stillClaimable;
      try {
        stillClaimable = await this.rpcPool.withReadFailover((c) => c.claimable(epoch, this.rpcPool.address));
      } catch (err) {
        console.error(`[claims] failed checking claimable() for epoch ${epochKey}:`, err.message);
        continue;
      }
      if (!stillClaimable) {
        this.queue.delete(epochKey); // already claimed elsewhere, or no longer eligible
        continue;
      }
      try {
        const [round, ledgerEntry] = await this.rpcPool.withReadFailover((c) =>
          Promise.all([c.rounds(epoch), c.ledger(epoch, this.rpcPool.address)])
        );
        if (round.rewardBaseCalAmount === 0n) continue;
        const reward = (ledgerEntry.amount * round.rewardAmount) / round.rewardBaseCalAmount;
        totalRewardWei += reward;
        epochs.push(epoch);
      } catch (err) {
        console.error(`[claims] failed reading reward data for epoch ${epochKey}:`, err.message);
      }
    }

    if (!epochs.length) return;

    let gasEstimate;
    try {
      gasEstimate = await this.rpcPool.withReadFailover((c) => c.claim.estimateGas(epochs));
    } catch (err) {
      console.error('[claims] gas estimation failed, will retry next check:', err.message);
      return;
    }

    let gasPrice;
    try {
      const feeData = await this.rpcPool.withReadFailover((_c, p) => p.getFeeData());
      gasPrice = feeData.gasPrice ?? 3_000_000_000n;
    } catch {
      gasPrice = 3_000_000_000n; // ~3 gwei fallback if fee data is unavailable everywhere
    }

    const estimatedGasCostWei = gasEstimate * gasPrice;
    const requiredWei = (estimatedGasCostWei * BigInt(Math.round(this.gasBufferMultiplier * 100))) / 100n;
    const forcedByQueueCap = epochs.length >= this.maxQueueSize;

    if (totalRewardWei < requiredWei && !forcedByQueueCap) {
      const msg = `${epochs.length} claimable epoch(s) worth ~${ethers.formatEther(totalRewardWei)} BNB ` +
        `don't yet clear ${this.gasBufferMultiplier}x estimated gas (~${ethers.formatEther(estimatedGasCostWei)} BNB) - waiting for more to accumulate`;
      console.log(`[claims] ${msg}`);
      return;
    }

    const claimMsg = `claiming ${epochs.length} epoch(s) for ~${ethers.formatEther(totalRewardWei)} BNB ` +
      `(est. gas ~${ethers.formatEther(estimatedGasCostWei)} BNB)${forcedByQueueCap ? ' [forced: queue cap reached]' : ''}`;
    console.log(`[claims] ${claimMsg}`);
    this.onEvent(claimMsg);
    try {
      const { contract } = this.rpcPool.current;
      const tx = await contract.claim(epochs, { gasLimit: (gasEstimate * 130n) / 100n });
      console.log(`[claims] tx sent: ${tx.hash}`);
      await tx.wait();
      console.log('[claims] tx confirmed');
      this.onEvent(`claim confirmed for ${epochs.length} epoch(s), ~${ethers.formatEther(totalRewardWei)} BNB`);
      for (const epoch of epochs) this.queue.delete(epoch.toString());
    } catch (err) {
      console.error('[claims] claim tx failed, will retry next check:', err.message);
      this.onEvent(`claim tx failed: ${err.message}`);
      if (isTransientRpcError(err)) this.rpcPool.rotate(); // use a different endpoint next time - do NOT resend this tx
    }
  }
}
