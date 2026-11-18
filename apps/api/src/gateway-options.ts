export interface GatewayOptions {
  globalConcurrency: number;
  connectionConcurrency: number;
  timeout: number;
  summaryTimeout: number;
  insightsTimeout: number;
  insightsMaxTokens: number;
  retryDelay: number;
}

export const defaultGatewayOptions: Readonly<GatewayOptions> = Object.freeze({
  globalConcurrency: 4,
  connectionConcurrency: 2,
  timeout: 60000,
  summaryTimeout: 90000,
  insightsTimeout: 180000,
  insightsMaxTokens: 8192,
  retryDelay: 400,
});

export function readGatewayOptions(env: NodeJS.ProcessEnv): GatewayOptions {
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    globalConcurrency: positive('MODEL_CONCURRENCY', defaultGatewayOptions.globalConcurrency),
    connectionConcurrency: positive(
      'CONNECTION_CONCURRENCY',
      defaultGatewayOptions.connectionConcurrency,
    ),
    timeout: positive('MODEL_TIMEOUT_MS', defaultGatewayOptions.timeout),
    summaryTimeout: positive('SUMMARY_TIMEOUT_MS', defaultGatewayOptions.summaryTimeout),
    insightsTimeout: positive('INSIGHTS_TIMEOUT_MS', defaultGatewayOptions.insightsTimeout),
    insightsMaxTokens: positive('INSIGHTS_MAX_TOKENS', defaultGatewayOptions.insightsMaxTokens),
    retryDelay: defaultGatewayOptions.retryDelay,
  };
}
