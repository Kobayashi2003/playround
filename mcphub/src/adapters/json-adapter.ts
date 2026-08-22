import {
  parse,
  modify,
  applyEdits,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import { atomicWrite, backupFile, readTextIfExists } from "../fsutil.js";
import type { McpServer } from "../types.js";
import type { ToolAdapter } from "./types.js";
import { asServerMap, toDefinition } from "./entry.js";

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2 };

/**
 * Shared adapter for tools that store MCP servers in a JSON/JSONC file.
 * `serversKey` is the top-level property ("mcpServers" or "servers"); `toEntry`
 * shapes a definition into the tool's expected entry format.
 */
export class JsonAdapter implements ToolAdapter {
  constructor(
    readonly configPath: string,
    private readonly serversKey: string,
    private readonly toEntry: (def: McpServer) => Record<string, unknown>
  ) {}

  /** Parse tolerant JSONC but reject files with real syntax errors, to avoid
   *  a corrupt input silently producing a corrupt output. */
  private parse(text: string): Record<string, unknown> | undefined {
    const errors: ParseError[] = [];
    const root = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throw new Error(`${this.configPath} is not valid JSON; fix or remove it first`);
    }
    return root as Record<string, unknown> | undefined;
  }

  private textOrEmpty(): string {
    const raw = readTextIfExists(this.configPath);
    return raw && raw.trim() ? raw : "{}";
  }

  listPresent(): string[] {
    const root = this.parse(this.textOrEmpty());
    return Object.keys(asServerMap(root?.[this.serversKey]));
  }

  readServer(name: string): McpServer | null {
    const root = this.parse(this.textOrEmpty());
    return toDefinition(asServerMap(root?.[this.serversKey])[name]);
  }

  enable(name: string, def: McpServer): string | null {
    const text = this.textOrEmpty();
    this.parse(text); // validate before mutating; refuses on corrupt input
    const backup = backupFile(this.configPath);
    const edits = modify(text, [this.serversKey, name], this.toEntry(def), {
      formattingOptions: FORMAT,
    });
    atomicWrite(this.configPath, applyEdits(text, edits));
    return backup;
  }

  disable(name: string): string | null {
    const raw = readTextIfExists(this.configPath);
    if (!raw || !raw.trim()) return null;
    this.parse(raw); // validate before mutating
    const text = raw;
    const backup = backupFile(this.configPath);
    const edits = modify(text, [this.serversKey, name], undefined, {
      formattingOptions: FORMAT,
    });
    atomicWrite(this.configPath, applyEdits(text, edits));
    return backup;
  }
}
