"use client";

import {agentVaultAbi, erc20Abi} from "@agentvault/shared";
import {useQuery} from "@tanstack/react-query";
import {useMemo} from "react";
import {zeroAddress, type Address} from "viem";
import {useAccount, useReadContracts} from "wagmi";
import {agentApi, type AgentRegisteredService, type AgentStatus} from "@/lib/agent-api";
import {chainConfig, vaultAddress} from "@/lib/config";

/**
 * On-chain reads, through the user's own wallet/RPC connection.
 *
 * Anything this hook returns is authoritative — it is what the contract says.
 * It is deliberately kept separate from `useAgentStatus` below, which reports
 * what a server believes, so the UI can label the two differently rather than
 * blending them into one comforting number.
 */

export interface VaultSession {
  maxPerTx: bigint;
  dailyLimit: bigint;
  expiresAt: bigint;
  windowDay: bigint;
  spentInWindow: bigint;
  revoked: boolean;
  exists: boolean;
}

export interface VaultChainData {
  enabled: boolean;
  onCorrectChain: boolean;
  configured: boolean;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  owner: Address | undefined;
  paused: boolean | undefined;
  token: Address | undefined;
  balance: bigint | undefined;
  session: VaultSession | undefined;
  remainingDaily: bigint | undefined;
}

export function useVaultChainData(sessionKey: Address | undefined): VaultChainData {
  const {chain, isConnected} = useAccount();
  const onCorrectChain = !isConnected || chain?.id === chainConfig.chainId;
  const enabled = Boolean(vaultAddress);

  // A fixed-length tuple so wagmi can infer each result's type. When no session
  // key is known yet the last two calls read the zero address, which returns an
  // empty session — harmless, and discarded below rather than displayed.
  const probeKey = sessionKey ?? zeroAddress;
  const vault = vaultAddress ?? zeroAddress;

  const query = useReadContracts({
    allowFailure: true,
    contracts: [
      {address: vault, abi: agentVaultAbi, functionName: "owner"},
      {address: vault, abi: agentVaultAbi, functionName: "paused"},
      {address: vault, abi: agentVaultAbi, functionName: "USDC"},
      {
        address: chainConfig.usdcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      },
      {address: vault, abi: agentVaultAbi, functionName: "getSession", args: [probeKey]},
      {
        address: vault,
        abi: agentVaultAbi,
        functionName: "remainingDailyAllowance",
        args: [probeKey],
      },
    ],
    query: {enabled, refetchInterval: 15_000},
  });

  const [ownerR, pausedR, usdcR, balanceR, sessionR, remainingR] = query.data ?? [];

  // Built directly rather than memoised: the object is cheap, and `refetch`
  // closes over `query` so a dependency list could not keep it stable anyway.
  return {
      enabled,
      onCorrectChain,
      configured: Boolean(vaultAddress),
      isLoading: query.isLoading,
      isError: query.isError,
      refetch: () => void query.refetch(),
      owner: ownerR?.status === "success" ? (ownerR.result as Address) : undefined,
      paused: pausedR?.status === "success" ? (pausedR.result as boolean) : undefined,
      token: usdcR?.status === "success" ? (usdcR.result as Address) : undefined,
      balance: balanceR?.status === "success" ? (balanceR.result as bigint) : undefined,
      session:
        sessionKey && sessionR?.status === "success"
          ? (sessionR.result as unknown as VaultSession)
          : undefined,
    remainingDaily:
      sessionKey && remainingR?.status === "success" ? (remainingR.result as bigint) : undefined,
  };
}

/** Is the connected wallet the vault owner? Gates every policy write. */
export function useIsOperator(owner: Address | undefined): boolean {
  const {address} = useAccount();
  return Boolean(address && owner && address.toLowerCase() === owner.toLowerCase());
}

/** Backend-derived vault view. Convenient, explicitly not authoritative. */
export function useAgentStatus() {
  return useQuery<AgentStatus>({
    queryKey: ["agent", "status"],
    queryFn: agentApi.status,
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function useAgentServices() {
  return useQuery<{services: AgentRegisteredService[]}>({
    queryKey: ["agent", "services"],
    queryFn: agentApi.services,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useAgentActivity(limit = 100) {
  return useQuery({
    queryKey: ["agent", "activity", limit],
    queryFn: () => agentApi.activity(limit),
    refetchInterval: 10_000,
    retry: 1,
  });
}

/** Which registered recipients the contract currently allows for this session. */
export interface RecipientApprovals {
  approvals: Map<string, boolean | undefined>;
  isLoading: boolean;
  enabled: boolean;
  refetch: () => void;
}

export function useRecipientApprovals(
  sessionKey: Address | undefined,
  recipients: Address[],
): RecipientApprovals {
  const {chain, isConnected} = useAccount();
  const enabled =
    Boolean(vaultAddress) && Boolean(sessionKey) && recipients.length > 0;

  const query = useReadContracts({
    allowFailure: true,
    contracts:
      vaultAddress && sessionKey
        ? recipients.map((r) => ({
            address: vaultAddress,
            abi: agentVaultAbi,
            functionName: "isRecipientAllowed" as const,
            args: [sessionKey, r] as const,
          }))
        : [],
    query: {enabled, refetchInterval: 20_000},
  });

  const approvals = useMemo(() => {
    const map = new Map<string, boolean | undefined>();
    recipients.forEach((r, i) => {
      const entry = query.data?.[i];
      map.set(r.toLowerCase(), entry?.status === "success" ? (entry.result as boolean) : undefined);
    });
    return map;
  }, [recipients, query.data]);

  return {approvals, isLoading: query.isLoading, enabled, refetch: () => void query.refetch()};
}
