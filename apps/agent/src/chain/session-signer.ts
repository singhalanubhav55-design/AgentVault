import {
  ARC_CONFIRMATIONS,
  agentVaultAbi,
  arcChain,
  erc20Abi,
  type ChainConfig,
} from "@agentvault/shared";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";

/**
 * The session signer — the agent's entire authority, in one place.
 *
 * This module holds the only secret the agent runtime possesses, and it never
 * leaves the server: nothing here is imported by the frontend, and the key is
 * read from the process environment only. The model sees the session ADDRESS
 * and never the key (threat T-17).
 *
 * That key can call exactly one contract function, `pay`, and only within the
 * policy the operator signed on chain. It cannot widen a limit, add a
 * recipient, withdraw, pause, or transfer ownership: those are `onlyOwner` and
 * this is not the owner. Three identities stay separate by construction —
 *
 *   operator wallet  browser-side, signs policy. Never in this process.
 *   vault            holds the USDC. Owns nothing, signs nothing.
 *   session signer   this. Spends within policy. Holds no authority to change it.
 *
 * PHASE 2: when signed intents land, `pay` becomes an EIP-712 signature handed
 * to a relayer and the agent stops needing gas at all. Callers of
 * `createSessionSigner` should not need to change.
 */
export interface SessionSigner {
  /** The session key's address. The only part of the key the model ever sees. */
  address: Address;
  vault: Address;
  publicClient: PublicClient;

  /**
   * Simulate, then submit `vault.pay`.
   *
   * The simulation is not decoration: it turns a doomed transaction into a
   * decodable custom error before any gas is spent, and it closes the race
   * where another payment consumes the daily budget between the preview and
   * the send. A revert here surfaces as a viem `ContractFunctionRevertedError`
   * that `decodeRejection` can read.
   */
  pay(token: Address, to: Address, amountBaseUnits: bigint, intentHash: Hex): Promise<Hex>;

  /** Wait for finality. Arc is deterministic, so one confirmation is final. */
  confirm(txHash: Hex): Promise<TransactionReceipt>;

  /** Pull the settlement facts back out of a mined receipt. */
  parsePaymentEvent(receipt: TransactionReceipt): SettledPayment | null;

  /** `[allowed, RejectionReason]` — the reason is the uint8 enum value. */
  preview(
    token: Address,
    to: Address,
    amountBaseUnits: bigint,
  ): Promise<readonly [boolean, number]>;

  /** Vault USDC balance, 6dp base units. */
  vaultBalance(): Promise<bigint>;

  /** Spend still available to this session today, 6dp base units. */
  remainingDailyAllowance(): Promise<bigint>;

  getSession(): Promise<SessionView>;
  isRecipientAllowed(recipient: Address): Promise<boolean>;
  isPaused(): Promise<boolean>;

  /** Native USDC held by the session key, for GAS only — not spendable value. */
  gasBalance(): Promise<bigint>;
}

export interface SettledPayment {
  sessionKey: Address;
  to: Address;
  token: Address;
  amount: bigint;
  intentHash: Hex;
  spentInWindow: bigint;
}

export interface SessionView {
  maxPerTx: bigint;
  dailyLimit: bigint;
  expiresAt: bigint;
  windowDay: bigint;
  spentInWindow: bigint;
  revoked: boolean;
  exists: boolean;
}

export function createSessionSigner(
  config: ChainConfig,
  privateKey: Hex,
  vault: Address,
): SessionSigner {
  const chain = arcChain(config);
  const account = privateKeyToAccount(privateKey);

  const transport = http(config.rpcUrl, {
    retryCount: 3,
    retryDelay: 1000,
    timeout: 20_000,
  });
  const publicClient: PublicClient = createPublicClient({chain, transport});
  const walletClient = createWalletClient({account, chain, transport});

  return {
    address: account.address,
    vault,
    publicClient,

    async pay(token, to, amountBaseUnits, intentHash) {
      const {request} = await publicClient.simulateContract({
        account,
        address: vault,
        abi: agentVaultAbi,
        functionName: "pay",
        args: [token, to, amountBaseUnits, intentHash],
      });
      return walletClient.writeContract(request);
    },

    async confirm(txHash) {
      return publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: ARC_CONFIRMATIONS,
        // Bounded: an unbounded wait would hang the agent run. A timeout is
        // reported as "unconfirmed", never as failure — see payments.ts.
        timeout: 60_000,
      });
    },

    parsePaymentEvent(receipt) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: agentVaultAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "PaymentExecuted") {
            return decoded.args as unknown as SettledPayment;
          }
        } catch {
          continue; // not one of ours
        }
      }
      return null;
    },

    async preview(token, to, amountBaseUnits) {
      return publicClient.readContract({
        address: vault,
        abi: agentVaultAbi,
        functionName: "previewPay",
        args: [account.address, token, to, amountBaseUnits],
      }) as Promise<readonly [boolean, number]>;
    },

    async vaultBalance() {
      return publicClient.readContract({
        address: config.usdcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }) as Promise<bigint>;
    },

    async remainingDailyAllowance() {
      return publicClient.readContract({
        address: vault,
        abi: agentVaultAbi,
        functionName: "remainingDailyAllowance",
        args: [account.address],
      }) as Promise<bigint>;
    },

    async getSession() {
      return publicClient.readContract({
        address: vault,
        abi: agentVaultAbi,
        functionName: "getSession",
        args: [account.address],
      }) as Promise<SessionView>;
    },

    async isRecipientAllowed(recipient) {
      return publicClient.readContract({
        address: vault,
        abi: agentVaultAbi,
        functionName: "isRecipientAllowed",
        args: [account.address, recipient],
      }) as Promise<boolean>;
    },

    async isPaused() {
      return publicClient.readContract({
        address: vault,
        abi: agentVaultAbi,
        functionName: "paused",
      }) as Promise<boolean>;
    },

    async gasBalance() {
      return publicClient.getBalance({address: account.address});
    },
  };
}
