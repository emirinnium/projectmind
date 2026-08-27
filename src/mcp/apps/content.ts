import { APPS_VERSION, type AppComponent } from './types.js';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolResultLike {
  content: TextBlock[];
  // SDK CallToolResult carries an index signature ([x: string]: unknown).
  // Mirror it so wrapper results stay assignable to the SDK result type.
  [key: string]: unknown;
}

/** Serialize a set of app components into the mcp-apps envelope JSON. */
export function buildAppsPayload(apps: AppComponent[]): string {
  return JSON.stringify({ 'mcp-apps': APPS_VERSION, components: apps });
}

/**
 * Append MCP Apps components to a tool result.
 *
 * The envelope is carried in a plain text content block, so the result stays
 * valid for every MCP client (SDK schema, Claude Desktop, Cursor, OpenCode…)
 * while clients with Apps/UI support can render the components.
 */
export function attachApps(result: ToolResultLike, apps: AppComponent[]): ToolResultLike {
  if (apps.length === 0) return result;
  return { content: [...result.content, { type: 'text', text: buildAppsPayload(apps) }] };
}