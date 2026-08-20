/**
 * Renders a JSON Schema as a flat markdown table.
 *
 * Nested objects become dotted paths and arrays get a `[]` segment, so
 * `officers[].officer_id` reads the way somebody would write it when picking
 * the field out of a response. A tree would be prettier and much harder to
 * search, and searching is what people actually do with reference docs.
 */

export interface SchemaRow {
  path: string;
  type: string;
  required: boolean;
  description: string;
}

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  additionalProperties?: JsonSchemaNode | boolean;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
}

const MAX_DEPTH = 5;

function asNode(value: unknown): JsonSchemaNode {
  return typeof value === 'object' && value !== null ? (value as JsonSchemaNode) : {};
}

/**
 * Zod's optional fields arrive as `anyOf: [T, {type: 'null'}]` or as a plain
 * union. Unwrap to the meaningful branch so the table says `string` rather
 * than `string | null` on every optional field.
 */
function unwrap(node: JsonSchemaNode): JsonSchemaNode {
  const union = node.anyOf ?? node.oneOf;
  if (union === undefined || union.length === 0) return node;
  const meaningful = union.map(asNode).filter((branch) => branch.type !== 'null');
  return meaningful.length === 1 ? meaningful[0]! : node;
}

function describeType(node: JsonSchemaNode): string {
  const resolved = unwrap(node);

  if (resolved.const !== undefined) return `\`${JSON.stringify(resolved.const)}\``;

  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) {
    const values = resolved.enum.map((value) => `\`${String(value)}\``);
    // A long enum in a table cell is unreadable; the full list is in the
    // schema and, for signals, in the tool's own documentation.
    return values.length > 6 ? `enum (${values.length} values)` : values.join(' \\| ');
  }

  const union = resolved.anyOf ?? resolved.oneOf;
  if (union !== undefined) {
    return [...new Set(union.map((branch) => describeType(asNode(branch))))].join(' \\| ');
  }

  const type = Array.isArray(resolved.type) ? resolved.type.join(' \\| ') : resolved.type;

  if (type === 'array') {
    const items = resolved.items === undefined ? 'unknown' : describeType(asNode(resolved.items));
    return `${items}[]`;
  }

  if (type === 'object' && resolved.properties === undefined) return 'object';

  return type ?? 'unknown';
}

export function schemaToRows(schema: unknown, prefix = '', depth = 0): SchemaRow[] {
  const node = unwrap(asNode(schema));
  if (depth > MAX_DEPTH) return [];

  if (node.type === 'array' || node.items !== undefined) {
    return schemaToRows(node.items, `${prefix}[]`, depth);
  }

  const properties = node.properties;
  if (properties === undefined) return [];

  const required = new Set(node.required ?? []);
  const rows: SchemaRow[] = [];

  for (const [name, rawChild] of Object.entries(properties)) {
    const child = asNode(rawChild);
    const resolved = unwrap(child);
    const path = prefix === '' ? name : `${prefix}.${name}`;

    rows.push({
      path,
      type: describeType(child),
      required: required.has(name),
      description: (resolved.description ?? child.description ?? '').replace(/\s+/g, ' ').trim()
    });

    // Recurse into anything with a shape of its own.
    if (resolved.properties !== undefined) {
      rows.push(...schemaToRows(resolved, path, depth + 1));
    } else if (resolved.type === 'array' && resolved.items !== undefined) {
      const items = unwrap(asNode(resolved.items));
      if (items.properties !== undefined) {
        rows.push(...schemaToRows(items, `${path}[]`, depth + 1));
      }
    }
  }

  return rows;
}

export function rowsToTable(rows: SchemaRow[], emptyNote: string): string {
  if (rows.length === 0) return `${emptyNote}\n`;

  const lines = ['| Field | Type | Required | Description |', '|---|---|---|---|'];
  for (const row of rows) {
    lines.push(
      `| \`${row.path}\` | ${row.type} | ${row.required ? 'yes' : 'no'} | ${row.description || '—'} |`
    );
  }
  return `${lines.join('\n')}\n`;
}
