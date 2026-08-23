/**
 * FEAT-L7-08 · MCP Client
 *
 * 用 @modelcontextprotocol/sdk 连接任意 MCP server，把对方暴露的 tools 包装成 AgentSkill 注册进 SkillRegistry。
 *
 * 当前实现：
 *   - 仅 stdio transport（最普遍，echo / fetch / filesystem 等官方 demo 都用 stdio）
 *   - sse / http transport 留接口，本期不实现
 *
 * 失败处理：连接失败不抛，只 log（启动期不阻塞主流程，符合设计文档 R4）。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AgentSkillRegistry } from './skillRegistry.js';
import type { AgentSkill } from './types.js';

export interface MCPServerConfig {
  /** 唯一名 · 用作 skill 命名前缀 */
  name: string;
  /** 当前仅支持 stdio · sse/http 留作未来扩展 */
  transport: 'stdio';
  /** stdio · 启动命令（如 "npx" / "uvx"） */
  command: string;
  /** stdio · 命令参数 */
  args?: string[];
  /** 可选 · 环境变量 */
  env?: Record<string, string>;
}

export class MCPClient {
  private readonly clients: Array<{ name: string; client: Client }> = [];
  private readonly log: (msg: string) => void;

  constructor(log?: (msg: string) => void) {
    this.log = log ?? ((m) => console.log(`[MCPClient] ${m}`));
  }

  /** 启动一个 MCP server 子进程并 handshake · 失败时不抛 */
  async connect(config: MCPServerConfig): Promise<boolean> {
    if (config.transport !== 'stdio') {
      this.log(`[mcp] transport=${config.transport} 暂不支持 · 跳过 ${config.name}`);
      return false;
    }
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env,
      });
      const client = new Client(
        { name: `mineclaw-${config.name}`, version: '0.1.0' },
        { capabilities: {} },
      );
      await client.connect(transport);
      this.clients.push({ name: config.name, client });
      this.log(`[mcp] connected to ${config.name} (${config.command})`);
      return true;
    } catch (err) {
      this.log(`[mcp] connect to ${config.name} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 把每个已连接 MCP server 暴露的 tools 拉过来，包装成 AgentSkill 注册进 registry。
   * 每个 server 上一个工具就是一个 skill：
   *   name: `<serverName>:<toolName>`
   *   description: 工具自带的 description
   *   uses: 空（外部工具调用走 callRemoteTool 不走 ToolDispatcher）
   */
  async exportAsSkills(registry: AgentSkillRegistry): Promise<void> {
    for (const { name, client } of this.clients) {
      try {
        const { tools } = await client.listTools();
        for (const tool of tools) {
          const skill: AgentSkill = {
            meta: {
              name: `${name}:${tool.name}`,
              description: tool.description ?? `MCP tool from ${name}`,
              category: 'mcp',
              triggers: [],
              uses: [],
            },
            body: this.buildToolSkillBody(tool),
            dir: '<mcp>',
            source: 'mcp',
          };
          registry.register(skill);
        }
        this.log(`[mcp] ${name}: 注册 ${tools.length} 个 skill`);
      } catch (err) {
        this.log(`[mcp] ${name} listTools 失败: ${(err as Error).message}`);
      }
    }
  }

  /**
   * 调用某个 MCP server 上的工具 · 给后期"skill 内部触发 MCP 工具"用。
   * 本期不接入到 ToolDispatcher（避免破坏 L4/L5/L6/L7 已有架构），暴露 API 供测试。
   */
  async callRemoteTool(serverName: string, toolName: string, args: object): Promise<unknown> {
    const entry = this.clients.find(c => c.name === serverName);
    if (!entry) throw new Error(`MCP server not connected: ${serverName}`);
    const res = await entry.client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
    return res;
  }

  /** 关闭所有连接 */
  async close(): Promise<void> {
    for (const { name, client } of this.clients) {
      try { await client.close(); }
      catch (err) { this.log(`[mcp] close ${name} 异常: ${(err as Error).message}`); }
    }
    this.clients.length = 0;
  }

  /** 当前连上的 server 数量 */
  size(): number {
    return this.clients.length;
  }

  private buildToolSkillBody(tool: { name: string; description?: string; inputSchema?: unknown }): string {
    return [
      `# MCP tool · ${tool.name}`,
      '',
      tool.description ? `## 描述\n${tool.description}` : '',
      '',
      '## 调用',
      'MCP server 暴露的远端工具。激活本 skill 时 LLMToolLoop 暂不支持自动 dispatch 到 MCP（本期范围外），',
      '需要在主 LLM 应用层显式 callRemoteTool。',
      '',
      tool.inputSchema ? `## inputSchema\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');
  }
}
