// @ts-nocheck
import { OpenAICompatibleProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { CustomProvider } from './custom.js';
import { AcpluginProvider } from './acplugin.js';
import { ProviderError } from './base.js';

// Provider 注册表：type -> 适配器工厂
const REGISTRY = {
  openai: (cfg) => new OpenAICompatibleProvider(cfg),
  anthropic: (cfg) => new AnthropicProvider(cfg),
  ollama: (cfg) => new OllamaProvider(cfg),
  custom: (cfg) => new CustomProvider(cfg),
  acplugin: (cfg) => new AcpluginProvider(cfg),
};

export function getProvider(cfg) {
  const type = cfg.type || cfg.provider;
  let factory = REGISTRY[type];
  if (!factory) {
    // 未知 / 自定义协议：按关键字推断；默认回退到 OpenAI 兼容协议
    //（deepseek / qwen / gemini(openai 模式) / azure openai 等多数为 OpenAI 兼容）
    if (/anthropic|claude/i.test(type)) factory = REGISTRY.anthropic;
    else if (/ollama/i.test(type)) factory = REGISTRY.ollama;
    else factory = REGISTRY.openai;
  }
  return factory(cfg);
}

export { ProviderError };
