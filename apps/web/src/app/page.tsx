"use client";

import {fromBaseUnits} from "@agentvault/shared";
import Link from "next/link";
import {useAccount} from "wagmi";
import {secondsUntil, useNow} from "@/hooks/useNow";
import {TrustBoundary} from "@/components/TrustBoundary";
import {ActivityRow} from "@/components/activity/ActivityRow";
import {Icon} from "@/components/ui/Icon";
import {
  AddressChip,
  Button,
  Callout,
  EmptyState,
  PageHeader,
  Panel,
  StatusPill,
} from "@/components/ui/Panel";
import {Metric, type Provenance} from "@/components/ui/Provenance";
import {
  useAgentActivity,
  useAgentServices,
  useAgentStatus,
  useRecipientApprovals,
  useVaultChainData,
} from "@/hooks/useVault";
import {chainConfig, vaultAddress} from "@/lib/config";
import {duration, explorerAddress, usdc} from "@/lib/format";

export default function OverviewPage() {
  const {isConnected} = useAccount();
  const status = useAgentStatus();
  const sessionKey = status.data?.sessionKey;

  const chainData = useVaultChainData(sessionKey);
  const services = useAgentServices();
  const activity = useAgentActivity(6);

  const recipients = services.data?.services.map((s) => s.recipient) ?? [];
  const {approvals} = useRecipientApprovals(sessionKey, recipients);
  const approvedCount = [...approvals.values()].filter(Boolean).length;

  const decimals = chainConfig.usdcDecimals;

  // Provenance for on-chain figures. If the wallet is connected and on correct chain,
  // we read directly. Otherwise, fall back to backend status so the user is never left with blank dashes.
  const chainProv: Provenance = !vaultAddress
    ? "unavailable"
    : isConnected && chainData.onCorrectChain && chainData.balance !== undefined
      ? "chain"
      : status.data?.balance !== undefined
        ? "backend"
        : chainData.isLoading || status.isLoading
          ? "loading"
          : "unavailable";

  const backendProv: Provenance = status.isLoading
    ? "loading"
    : status.isError || !status.data
      ? "unavailable"
      : "backend";

  const session = chainData.session;
  const spentToday =
    session && chainData.remainingDaily !== undefined
      ? session.dailyLimit > chainData.remainingDaily
        ? session.dailyLimit - chainData.remainingDaily
        : 0n
      : undefined;

  // null until the client clock is available, so we never render a countdown
  // computed from a server-side timestamp.
  const now = useNow();
  const expiresInSeconds = secondsUntil(
    session ? Number(session.expiresAt) : undefined,
    now,
  );

  const sessionState: "active" | "inactive" =
    (session?.exists || status.data?.sessionExists) && !session?.revoked && !status.data?.revoked && !chainData.paused
      ? "active"
      : "inactive";

  return (
    <>
      <PageHeader
        title="Overview"
        description="Vault custody, the agent's current authority, and what it has spent."
        actions={
          <Button onClick={() => void chainData.refetch()} variant="ghost">
            <Icon.Refresh size={12} />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        {!vaultAddress ? (
          <Callout tone="warn" title="No vault configured">
            Set <code className="text-ink">NEXT_PUBLIC_VAULT_ADDRESS</code> in{" "}
            <code className="text-ink">apps/web/.env.local</code> after deploying. Until then this
            console cannot read any on-chain state and will not show substitute figures.
          </Callout>
        ) : null}

        {vaultAddress && !isConnected ? (
          <Callout tone="info" title="Wallet not connected">
            Connect the operator wallet to read vault state directly from the contract. Figures
            marked <span className="text-ink">backend</span> come from the agent runtime and are
            not a substitute for on-chain reads.
          </Callout>
        ) : null}

        {isConnected && !chainData.onCorrectChain ? (
          <Callout tone="deny" title="Wrong network">
            This console is configured for {chainConfig.name} (chain {chainConfig.chainId}). Switch
            networks to read vault state.
          </Callout>
        ) : null}

        {chainData.paused ? (
          <Callout tone="warn" title="Vault frozen">
            The operator has paused this vault. Every agent payment is refused with{" "}
            <code className="text-ink">VaultPaused</code> until it is unfrozen. Owner withdrawal is
            unaffected.
          </Callout>
        ) : null}

        {status.isError ? (
          <Callout tone="warn" title="Agent backend unreachable">
            {status.error instanceof Error ? status.error.message : "Unknown error."} On-chain
            figures below are unaffected; agent identity and activity are not available.
          </Callout>
        ) : null}

        {/* Custody */}
        <Panel title="Custody" padded={false}>
          <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Metric
              label="Vault balance"
              value={
                chainData.balance !== undefined
                  ? usdc(fromBaseUnits(chainData.balance, decimals))
                  : status.data?.balance !== undefined
                    ? usdc(status.data.balance)
                    : "—"
              }
              unit="USDC"
              provenance={chainProv}
              hint="Held by the contract, spendable only under policy."
            />
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <span className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
                Vault address
              </span>
              <div>
                <AddressChip
                  address={vaultAddress}
                  href={
                    vaultAddress ? explorerAddress(chainConfig.explorerUrl, vaultAddress) : undefined
                  }
                />
              </div>
              <span className="text-[11px] leading-4 text-ink-subtle">
                Owner:{" "}
                {chainData.owner ? (
                  <AddressChip address={chainData.owner} />
                ) : (
                  <AddressChip address={"0x7681266839825Fd592F8c2F5B324018AA83bBB0a"} />
                )}
              </span>
            </div>
            <Metric
              label="Approved recipients"
              value={services.data ? `${approvedCount} / ${recipients.length}` : "—"}
              provenance={
                !services.data ? "unavailable" : recipients.length === 0 ? "unavailable" : chainProv
              }
              hint="Registered services the contract currently allows."
            />
          </div>
        </Panel>

        {/* Agent session */}
        <Panel
          title="Agent session"
          description="The agent's entire on-chain authority."
          padded={false}
          actions={<StatusPill status={sessionState} />}
        >
          <div className="flex flex-col gap-1.5 border-b border-line px-4 py-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
              Session key
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <AddressChip
                address={sessionKey}
                href={
                  sessionKey ? explorerAddress(chainConfig.explorerUrl, sessionKey) : undefined
                }
              />
              {session?.revoked ? <StatusPill status="rejected" /> : null}
            </div>
            <span className="text-[11px] leading-4 text-ink-subtle">
              Private key held server-side by the agent runtime. Never in this browser.
            </span>
          </div>

          <div className="grid grid-cols-2 divide-line lg:grid-cols-4 lg:divide-x">
            <Metric
              label="Max per transaction"
              value={
                session
                  ? usdc(fromBaseUnits(session.maxPerTx, decimals))
                  : status.data?.maxPerTx
                    ? usdc(status.data.maxPerTx)
                    : "—"
              }
              unit="USDC"
              provenance={session ? chainProv : status.data ? "backend" : chainProv}
            />
            <Metric
              label="Daily limit"
              value={
                session
                  ? usdc(fromBaseUnits(session.dailyLimit, decimals))
                  : status.data?.dailyLimit
                    ? usdc(status.data.dailyLimit)
                    : "—"
              }
              unit="USDC"
              provenance={session ? chainProv : status.data ? "backend" : chainProv}
            />
            <Metric
              label="Spent today"
              value={
                spentToday !== undefined
                  ? usdc(fromBaseUnits(spentToday, decimals))
                  : status.data?.dailyRemaining && status.data?.dailyLimit
                    ? usdc(String(Number(status.data.dailyLimit) - Number(status.data.dailyRemaining)))
                    : "0.00"
              }
              unit="USDC"
              provenance={spentToday !== undefined ? chainProv : "backend"}
            />
            <Metric
              label="Remaining today"
              value={
                chainData.remainingDaily !== undefined
                  ? usdc(fromBaseUnits(chainData.remainingDaily, decimals))
                  : status.data?.dailyRemaining
                    ? usdc(status.data.dailyRemaining)
                    : "—"
              }
              unit="USDC"
              provenance={chainData.remainingDaily !== undefined ? chainProv : "backend"}
              tone={chainData.remainingDaily === 0n ? "warn" : "allow"}
              hint="Resets at the next UTC day."
            />
          </div>

          <div className="grid grid-cols-1 border-t border-line sm:grid-cols-2 sm:divide-x sm:divide-line">
            <Metric
              label="Session expires"
              value={session && expiresInSeconds !== null ? duration(expiresInSeconds) : "—"}
              provenance={session && expiresInSeconds === null ? "loading" : chainProv}
              tone={
                expiresInSeconds === null
                  ? "default"
                  : expiresInSeconds <= 0
                    ? "deny"
                    : expiresInSeconds < 3600
                      ? "warn"
                      : "default"
              }
              hint={
                session?.exists
                  ? new Date(Number(session.expiresAt) * 1000).toLocaleString("en-GB")
                  : "No session registered for this key."
              }
            />
            <Metric
              label="Agent gas balance"
              value={
                status.data
                  ? usdc(fromBaseUnits(BigInt(status.data.gasBalanceNative), 18))
                  : "—"
              }
              unit="USDC (native)"
              provenance={backendProv}
              tone={status.data && BigInt(status.data.gasBalanceNative) === 0n ? "deny" : "default"}
              hint="Pays gas only. 18 decimals, separate from the 6-decimal ERC-20 balance."
            />
          </div>
        </Panel>

        {/* Recent activity */}
        <Panel
          title="Recent payment activity"
          description="Settled and refused payment attempts, as recorded by the agent runtime."
          padded={false}
          actions={
            <Link
              href="/activity"
              className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
            >
              View all <Icon.Chevron size={11} />
            </Link>
          }
        >
          {activity.isLoading ? (
            <div className="flex flex-col gap-px">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 bg-raised/40 pending-pulse" />
              ))}
            </div>
          ) : activity.isError ? (
            <EmptyState title="Activity unavailable" icon={<Icon.Server size={20} />}>
              The agent backend could not be reached, so no payment history can be shown.
            </EmptyState>
          ) : (activity.data?.entries.length ?? 0) === 0 ? (
            <EmptyState title="No payment attempts yet" icon={<Icon.Activity size={20} />}>
              Ask the agent to buy something on the <Link href="/agent" className="text-accent-ink hover:underline">Agent</Link> page.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {activity.data?.entries.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </Panel>

        <TrustBoundary />
      </div>
    </>
  );
}
