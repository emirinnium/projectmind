/**
 * MCP Apps component types (Cursor MCP Apps / interactive UI payloads).
 *
 * Components are emitted as a client-safe text content block carrying a JSON
 * envelope (`mcp-apps: v1`) so clients that do not know the format can still
 * read the payload, while clients with UI support (e.g. Cursor Apps) can
 * render charts and forms from the components array.
 */

export interface BarSeries {
  name: string;
  data: number[];
}

export interface BarChartOptions {
  labels: string[];
  series: BarSeries[];
}

export interface PieDatum {
  name: string;
  value: number;
}

export interface PieChartOptions {
  data: PieDatum[];
}

export type ChartOptions = BarChartOptions | PieChartOptions;

export interface FormField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean';
  required?: boolean;
  placeholder?: string;
  default?: string | number | boolean;
}

export type AppComponent =
  | { kind: 'chart'; chartType: 'bar' | 'pie' | 'line'; title: string; options: ChartOptions }
  | { kind: 'form'; title: string; fields: FormField[]; submitLabel?: string }
  | { kind: 'markdown'; content: string };

/** Version tag for the apps envelope; bump only on breaking payload changes. */
export const APPS_VERSION = 'v1';
