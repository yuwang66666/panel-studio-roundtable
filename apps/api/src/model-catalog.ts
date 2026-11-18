import { ConnectionInputSchema, type ConnectionInput } from '@panel/contracts';

export type ModelCatalog = {
  models: { id: string; input: ConnectionInput }[];
  defaultModeratorId: string | null;
};

/** Parse only explicitly listed entries. Never include environment values in errors. */
export function readModelCatalog(env: NodeJS.ProcessEnv): ModelCatalog {
  const aliases = (env.PANEL_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (aliases.some((s) => !/^[A-Z][A-Z0-9_]{0,39}$/.test(s)))
    throw new Error('PANEL_MODELS：模型标识须为大写字母、数字或下划线，且以字母开头，最长40字符');
  if (new Set(aliases).size !== aliases.length) throw new Error('PANEL_MODELS：模型标识不能重复');
  const models: ModelCatalog['models'] = [];
  for (const alias of aliases) {
    const prefix = `MODEL_${alias}_`;
    const value = (field: string) => env[prefix + field]?.trim() || '';
    // An untouched template is unavailable, rather than a selectable fake model.
    if (!value('MODEL') && !value('API_KEY')) continue;
    const structured = value('STRUCTURED_OUTPUT') || 'false';
    if (!['true', 'false'].includes(structured))
      throw new Error(`${prefix}STRUCTURED_OUTPUT：只能填写 true 或 false`);
    const result = ConnectionInputSchema.safeParse({
      name: value('NAME') || alias,
      provider: value('PROVIDER'),
      protocol: value('PROTOCOL'),
      baseUrl: value('BASE_URL'),
      model: value('MODEL'),
      apiKey: value('API_KEY'),
      structuredOutput: structured === 'true',
      active: true,
    });
    if (!result.success) {
      const fields: Record<string, string> = {
        name: 'NAME',
        provider: 'PROVIDER',
        protocol: 'PROTOCOL',
        baseUrl: 'BASE_URL',
        model: 'MODEL',
        apiKey: 'API_KEY',
      };
      throw new Error(
        `${prefix}配置不完整或格式错误，请检查：${[...new Set(result.error.issues.map((i) => prefix + (fields[String(i.path[0])] || 'STRUCTURED_OUTPUT')))].join('、')}`,
      );
    }
    models.push({ id: `env:${alias}`, input: result.data });
  }
  const defaultAlias = env.PANEL_DEFAULT_MODERATOR?.trim();
  const defaultModeratorId = defaultAlias ? `env:${defaultAlias}` : null;
  if (defaultModeratorId && !models.some((m) => m.id === defaultModeratorId))
    throw new Error('PANEL_DEFAULT_MODERATOR：请选择 PANEL_MODELS 中已完整配置的模型标识');
  return { models, defaultModeratorId };
}
