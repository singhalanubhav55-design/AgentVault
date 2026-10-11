import {arcChain} from "@agentvault/shared";
import {cookieStorage, createConfig, createStorage, http} from "wagmi";
import {injected} from "wagmi/connectors";
import {chainConfig} from "./config";

/**
 * wagmi config for Arc.
 *
 * `ssr: true` + cookie storage so the connection survives Next's server render
 * without a hydration mismatch.
 *
 * Only the injected connector for the MVP: it is what a judge running the demo
 * will have, and it avoids a WalletConnect project id as a hard dependency.
 */
export function getConfig() {
  const chain = arcChain(chainConfig);

  return createConfig({
    chains: [chain],
    connectors: [injected()],
    ssr: true,
    storage: createStorage({storage: cookieStorage}),
    transports: {
      [chain.id]: http(chainConfig.rpcUrl, {
        retryCount: 3,
        retryDelay: 1000,
        timeout: 20_000,
      }),
    },
  });
}

declare module "wagmi" {
  interface Register {
    config: ReturnType<typeof getConfig>;
  }
}
