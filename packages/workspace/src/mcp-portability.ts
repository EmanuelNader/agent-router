import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { parse as parseJsonc, visit, type ParseError } from 'jsonc-parser';

export type McpFormat = 'opencode-v1' | 'opencode-v2' | 'claude-code' | 'codex-cli';
export interface PortableMcpServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string[];
  url?: string;
  oauth?: boolean;
  env: Record<string, string>;
  headers: Record<string, string>;
  enabled: boolean;
}
const obj = z.record(z.string(), z.unknown());
const strings = z.record(z.string(), z.string());
const variable = /^[A-Za-z_][A-Za-z0-9_]*$/;
const secretKey = /token|secret|password|credential|api[_-]?key|authorization/i;
const reference = /^(?:Bearer )?(?:\{env:[A-Za-z_][A-Za-z0-9_]*\}|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/;

function readJson(text: string, comments: boolean): unknown {
  const errors: ParseError[] = [];
  const options = { disallowComments: !comments, allowTrailingComma: comments };
  const value = parseJsonc(text, errors, options);
  if (errors.length) throw new Error('MCP_INVALID_CONFIG');
  const stack: Set<string>[] = [];
  visit(text, {
    onObjectBegin: () => { stack.push(new Set()); },
    onObjectEnd: () => { stack.pop(); },
    onObjectProperty: key => {
      if (stack.at(-1)?.has(key)) throw new Error('MCP_DUPLICATE_KEY');
      stack.at(-1)?.add(key);
    },
  }, options);
  return value;
}

function normalize(value: string, format: McpFormat): string {
  if (format === 'claude-code') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{env:$1}');
  return value;
}
function render(value: string, format: McpFormat): string {
  return format === 'claude-code' ? value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => '${' + name + '}') : value;
}
function scan(value: unknown, key = ''): void {
  if (typeof value === 'string') {
    if (/(?:\/opt\/homebrew|\/Users\/|\/Applications\/|[A-Za-z]:\\|~\/)/.test(value)) throw new Error('MCP_NONPORTABLE_PATH');
    if ((secretKey.test(key) && !/_env_var$/.test(key) && !reference.test(value))
      || /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|-----BEGIN .*PRIVATE KEY|\$\{[^}]*:-)/.test(value)
      || /(?:--)?(?:token|password|api[-_]key|secret)\s*[=:]\s*(?!\{env:|\$\{)\S+/i.test(value)) throw new Error('MCP_SECRET_LITERAL');
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scan(value[i], key);
      if (typeof value[i] === 'string' && /^--?(?:api[-_]key|token|password|secret)$/i.test(value[i] as string)
        && !reference.test(String(value[i + 1] ?? ''))) throw new Error('MCP_SECRET_LITERAL');
    }
  } else if (value && typeof value === 'object') {
    for (const [field, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(field)) throw new Error('MCP_INVALID_CONFIG');
      if (field === 'env_http_headers') {
        if (!entry || typeof entry !== 'object' || Object.values(entry).some(v => typeof v !== 'string' || !variable.test(v))) throw new Error('MCP_INVALID_CONFIG');
      } else scan(entry, field);
    }
  }
}
function mapStrings(value: unknown, format: McpFormat): Record<string, string> {
  return Object.fromEntries(Object.entries(strings.parse(value ?? {})).map(([k, v]) => [k, normalize(v, format)]));
}
function only(server: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(server).some(key => !allowed.includes(key))) throw new Error('MCP_UNSUPPORTED_OPTION');
}

export function parseMcpConfig(text: string, format: McpFormat): PortableMcpServer[] {
  try {
    const document = obj.parse(format === 'codex-cli' ? parse(text) : readJson(text, format.startsWith('opencode')));
    scan(document);
    let entries: Record<string, unknown>;
    if (format === 'codex-cli') entries = obj.parse(document.mcp_servers ?? {});
    else if (format === 'claude-code') entries = obj.parse(document.mcpServers ?? {});
    else if (format === 'opencode-v2') {
      const mcp = obj.parse(document.mcp ?? {});
      only(mcp, ['servers']);
      entries = obj.parse(mcp.servers ?? {});
    } else entries = obj.parse(document.mcp ?? {});
    return Object.entries(entries).map(([name, value]) => {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('MCP_INVALID_CONFIG');
      const server = obj.parse(value);
      const open = format.startsWith('opencode');
      const codex = format === 'codex-cli';
      only(server, open ? ['type', 'command', 'environment', 'url', 'headers', format === 'opencode-v2' ? 'disabled' : 'enabled', 'oauth']
        : codex ? ['command', 'args', 'env', 'env_vars', 'url', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'enabled']
        : ['type', 'command', 'args', 'env', 'url', 'headers']);
      if (server.oauth !== undefined && server.oauth !== false) throw new Error('MCP_UNSUPPORTED_OPTION');
      if (server.enabled !== undefined && typeof server.enabled !== 'boolean') throw new Error('MCP_INVALID_CONFIG');
      if (server.disabled !== undefined && typeof server.disabled !== 'boolean') throw new Error('MCP_INVALID_CONFIG');
      const transport = server.url !== undefined ? 'http' : 'stdio';
      if (open && server.type !== (transport === 'http' ? 'remote' : 'local')) throw new Error('MCP_INVALID_CONFIG');
      if (!open && !codex && server.type !== undefined && server.type !== transport) throw new Error('MCP_UNSUPPORTED_OPTION');
      const env = mapStrings(server[open ? 'environment' : 'env'], format);
      const headers = mapStrings(server[codex ? 'http_headers' : 'headers'], format);
      if (codex && Object.values(env).some(v => /\{env:|\$\{/.test(v))) throw new Error('MCP_UNSUPPORTED_OPTION');
      if (codex) {
        for (const name of z.array(z.string().regex(variable)).parse(server.env_vars ?? [])) {
          if (name in env) throw new Error('MCP_AMBIGUOUS_ENV');
          env[name] = `{env:${name}}`;
        }
        for (const [header, name] of Object.entries(strings.parse(server.env_http_headers ?? {}))) {
          if (!variable.test(name) || header in headers) throw new Error('MCP_INVALID_CONFIG');
          headers[header] = `{env:${name}}`;
        }
        if (server.bearer_token_env_var !== undefined) {
          const name = z.string().regex(variable).parse(server.bearer_token_env_var);
          if (Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) throw new Error('MCP_INVALID_CONFIG');
          headers.Authorization = `Bearer {env:${name}}`;
        }
      }
      for (const [key, value] of Object.entries(env)) {
        if (!variable.test(key)) throw new Error('MCP_INVALID_CONFIG');
        if (!reference.test(value) && !['NODE_ENV', 'LOG_LEVEL', 'DEBUG'].includes(key)) throw new Error('MCP_SECRET_LITERAL');
      }
      for (const [key, value] of Object.entries(headers)) {
        if (!reference.test(value) && !['accept', 'content-type', 'user-agent'].includes(key.toLowerCase())) throw new Error('MCP_SECRET_LITERAL');
      }
      const enabled = server.enabled !== false && server.disabled !== true;
      if (transport === 'http') {
        if (server.command !== undefined || server.args !== undefined || server.env !== undefined || server.environment !== undefined || server.env_vars !== undefined) throw new Error('MCP_INVALID_CONFIG');
        const url = z.string().url().parse(server.url);
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('MCP_UNSAFE_URL');
        return { name, transport, url, env, headers, enabled, oauth: open ? server.oauth !== false : Object.keys(headers).length === 0 };
      }
      if (Object.keys(headers).length) throw new Error('MCP_INVALID_CONFIG');
      const command = open ? z.array(z.string().min(1)).min(1).parse(server.command)
        : [z.string().min(1).parse(server.command), ...z.array(z.string()).parse(server.args ?? [])];
      if (command.some(arg => /\{env:|\$\{/.test(arg))) throw new Error('MCP_COMMAND_EXPANSION_UNSUPPORTED');
      return { name, transport, command, env, headers, enabled };
    });
  } catch (error) {
    if (error instanceof Error && /^MCP_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('MCP_INVALID_CONFIG');
  }
}

export function translateMcpConfig(servers: PortableMcpServer[], format: McpFormat): string {
  const entries: Record<string, unknown> = Object.create(null);
  for (const server of servers) {
    const open = format.startsWith('opencode');
    const codex = format === 'codex-cli';
    if (entries[server.name]) throw new Error('MCP_INVALID_CONFIG');
    if (!server.enabled && format === 'claude-code') throw new Error('MCP_UNSUPPORTED_OPTION');
    if (!open && server.transport === 'http'
      && server.oauth !== (Object.keys(server.headers).length === 0)) throw new Error('MCP_AUTH_SEMANTICS_UNSUPPORTED');
    const out: Record<string, unknown> = {};
    if (server.transport === 'stdio') {
      if (!server.command?.length) throw new Error('MCP_INVALID_CONFIG');
      if (server.command.some(arg => /\{env:|\$\{/.test(arg))) throw new Error('MCP_COMMAND_EXPANSION_UNSUPPORTED');
      out.command = open ? server.command : server.command[0];
      if (!open) out.args = server.command.slice(1);
      if (open) out.type = 'local';
      else if (!codex) out.type = 'stdio';
      const env: Record<string, string> = Object.create(null);
      const forwarded: string[] = [];
      for (const [key, value] of Object.entries(server.env)) {
        if (codex && reference.test(value)) {
          if (value !== `{env:${key}}`) throw new Error('MCP_ENV_RENAME_UNSUPPORTED');
          forwarded.push(key);
        } else env[key] = render(value, format);
      }
      out[open ? 'environment' : 'env'] = env;
      if (forwarded.length) out.env_vars = forwarded;
    } else {
      out.url = server.url;
      if (open) { out.type = 'remote'; if (server.oauth === false) out.oauth = false; }
      else if (!codex) out.type = 'http';
      const headers: Record<string, string> = Object.create(null);
      const envHeaders: Record<string, string> = Object.create(null);
      for (const [key, value] of Object.entries(server.headers)) {
        if (codex && /^Bearer \{env:\w+\}$/.test(value) && key.toLowerCase() === 'authorization') out.bearer_token_env_var = value.slice(12, -1);
        else if (codex && /^\{env:\w+\}$/.test(value)) envHeaders[key] = value.slice(5, -1);
        else if (codex && value.includes('{env:')) throw new Error('MCP_UNSUPPORTED_OPTION');
        else headers[key] = render(value, format);
      }
      out[codex ? 'http_headers' : 'headers'] = headers;
      if (Object.keys(envHeaders).length) out.env_http_headers = envHeaders;
    }
    if (!server.enabled) out[format === 'opencode-v2' ? 'disabled' : 'enabled'] = format === 'opencode-v2';
    entries[server.name] = out;
  }
  const result = format === 'codex-cli' ? stringify({ mcp_servers: entries })
    : JSON.stringify(format === 'claude-code' ? { mcpServers: entries } : { mcp: format === 'opencode-v2' ? { servers: entries } : entries }, null, 2);
  // Validate generated output too; callers cannot bypass the scanner via an IR.
  parseMcpConfig(result, format);
  return result;
}

export async function inspectWorkspaceMcp(
  workspace: string,
  exclusions: string[] = ['node_modules', '.pnpm-store', '.work', '.cache'],
): Promise<{ configsChecked: number; serversChecked: number }> {
  let configsChecked = 0;
  let serversChecked = 0;
  async function walk(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      if (name === '.git' || exclusions.includes(name)) continue;
      const file = path.join(directory, name);
      const stat = await lstat(file);
      const config = name === 'opencode.json' || name === 'opencode.jsonc' || name === '.mcp.json'
        || (name === 'config.toml' && path.basename(directory) === '.codex');
      if (stat.isSymbolicLink()) {
        if (config || name === '.codex') throw new Error('MCP_INVALID_CONFIG');
        continue;
      }
      if (stat.isDirectory()) { await walk(file); continue; }
      if (!config) continue;
      if (!stat.isFile() || stat.size > 1_048_576) throw new Error('MCP_INVALID_CONFIG');
      const text = await readFile(file, 'utf8');
      let format: McpFormat = name === '.mcp.json' ? 'claude-code' : name === 'config.toml' ? 'codex-cli' : 'opencode-v2';
      if (format === 'opencode-v2') {
        const data = obj.parse(readJson(text, true));
        if (data.mcp && !Object.hasOwn(obj.parse(data.mcp), 'servers')) format = 'opencode-v1';
      }
      serversChecked += parseMcpConfig(text, format).length;
      configsChecked++;
    }
  }
  try {
    const root = path.resolve(workspace);
    if (!(await lstat(root)).isDirectory()) throw new Error('MCP_INVALID_CONFIG');
    await walk(root);
  }
  catch (error) {
    if (error instanceof Error && /^MCP_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('MCP_INVALID_CONFIG');
  }
  return { configsChecked, serversChecked };
}
