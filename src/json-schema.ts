/**
 * M2: JSON-Schema subset validator — không dependency. Hỗ trợ: type,
 * required, properties, enum, items, additionalProperties=false khi khai báo.
 * Trả về mảng lỗi (rỗng = hợp lệ). Dùng để validate MCP tool args trước
 * tools/call — lỗi local, không gọi server.
 */

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

/** Validate value theo schema subset. path dùng cho error message. */
export function validateSchema(
  value: unknown,
  schema: Record<string, unknown> | undefined,
  path = "args",
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const errors: string[] = [];
  const type = schema.type as string | string[] | undefined;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    const ok = types.some((t) => TYPE_CHECKS[t]?.(value));
    if (!ok) {
      errors.push(`${path}: expected ${types.join("|")}, got ${jsonType(value)}`);
      return errors; // sai type — không kiểm tra sâu hơn
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (TYPE_CHECKS.object(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push(`${path}: missing required property "${req}"`);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...validateSchema(v, props[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateSchema(item, schema.items as Record<string, unknown>, `${path}[${i}]`)));
  }
  return errors;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
