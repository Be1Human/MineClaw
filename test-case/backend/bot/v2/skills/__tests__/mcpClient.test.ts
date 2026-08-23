/**
 * FEAT-L7-08 · MCPClient 单测
 *
 * 由于 stdio MCP server 集成测试需要外部进程，本单测只覆盖：
 *   M-01 · 不连任何 server · size = 0
 *   M-02 · 连不存在的命令 · 返回 false 而非抛
 *   M-03 · exportAsSkills 空 client 不抛
 *   M-04 · close 空 client 不抛
 *
 * 真实 server 联通走 SMOKE-7 在线冒烟。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MCPClient } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/mcpClient.js';
import { AgentSkillRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/skillRegistry.js';

describe('MCPClient · 基础接口', () => {

  // M-01
  it('M-01 · 未连接时 size=0', () => {
    const mcp = new MCPClient(() => {});
    assert.equal(mcp.size(), 0);
  });

  // M-02
  it('M-02 · 连接到不存在的命令应返回 false 不抛', async () => {
    const mcp = new MCPClient(() => {});
    const ok = await mcp.connect({
      name: 'fake',
      transport: 'stdio',
      command: '/nonexistent/cmd/that/should/never/exist',
      args: [],
    });
    assert.equal(ok, false);
    assert.equal(mcp.size(), 0);
  });

  // M-03
  it('M-03 · exportAsSkills 空 client 不抛', async () => {
    const mcp = new MCPClient(() => {});
    const reg = new AgentSkillRegistry(() => {});
    await mcp.exportAsSkills(reg);
    assert.equal(reg.size(), 0);
  });

  // M-04
  it('M-04 · close 空 client 不抛', async () => {
    const mcp = new MCPClient(() => {});
    await mcp.close();
    assert.equal(mcp.size(), 0);
  });

});
