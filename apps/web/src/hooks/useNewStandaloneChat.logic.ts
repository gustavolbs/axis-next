import { isProviderAvailable, type ServerProvider } from "@t3tools/contracts";

export function isUsableStandaloneChatProvider(provider: ServerProvider): boolean {
  return provider.enabled && provider.installed && isProviderAvailable(provider);
}
