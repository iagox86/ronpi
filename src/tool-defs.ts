// pi's built-in tools ship renderers (`$ ls`, diffs, file previews) inside
// their tool definitions. ToolExecutionComponent only uses them when handed
// the definition, otherwise it prints raw JSON.
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type Factory = (cwd: string) => ToolDefinition<never, never, never>;

const FACTORIES: Record<string, Factory> = {
  bash: createBashToolDefinition as unknown as Factory,
  edit: createEditToolDefinition as unknown as Factory,
  find: createFindToolDefinition as unknown as Factory,
  grep: createGrepToolDefinition as unknown as Factory,
  ls: createLsToolDefinition as unknown as Factory,
  read: createReadToolDefinition as unknown as Factory,
  write: createWriteToolDefinition as unknown as Factory,
};

const cache = new Map<string, ToolDefinition<never, never, never>>();

/** The built-in definition for `name` (undefined for extension/MCP tools, which render generically). */
export function toolDefinitionFor(name: string, cwd: string): ToolDefinition<never, never, never> | undefined {
  const make = FACTORIES[name];
  if (!make) {
    return undefined;
  }
  const key = `${name}\0${cwd}`;
  let def = cache.get(key);
  if (!def) {
    def = make(cwd);
    cache.set(key, def);
  }
  return def;
}
