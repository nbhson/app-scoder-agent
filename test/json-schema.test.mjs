/**
 * M2: JSON-Schema subset validator.
 * Chạy: node --test test/json-schema.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSchema } from "../dist/shared/json-schema.js";

describe("validateSchema (M2)", () => {
  const schema = {
    type: "object",
    properties: {
      message: { type: "string" },
      count: { type: "integer" },
      mode: { type: "string", enum: ["fast", "slow"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["message"],
  };

  it("đúng schema → []", () => {
    assert.deepEqual(validateSchema({ message: "hi", count: 2, mode: "fast", tags: ["a"] }, schema), []);
  });

  it("sai type → error local", () => {
    const errs = validateSchema({ message: 42 }, schema);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /message: expected string, got number/);
  });

  it("missing required", () => {
    assert.match(validateSchema({}, schema)[0], /missing required property "message"/);
  });

  it("enum sai", () => {
    assert.match(validateSchema({ message: "x", mode: "turbo" }, schema)[0], /must be one of "fast", "slow"/);
  });

  it("array items sai type", () => {
    assert.match(validateSchema({ message: "x", tags: ["ok", 5] }, schema)[0], /tags\[1\]: expected string, got number/);
  });

  it("integer nhận number nguyên, từ chối 1.5", () => {
    assert.deepEqual(validateSchema({ message: "x", count: 1.5 }, schema).length, 1);
    assert.deepEqual(validateSchema({ message: "x", count: 3 }, schema), []);
  });

  it("additionalProperties: false → unexpected property", () => {
    const s = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    assert.match(validateSchema({ a: "x", b: 1 }, s)[0], /unexpected property "b"/);
  });

  it("không schema / schema rỗng → [] (pass-through)", () => {
    assert.deepEqual(validateSchema({ anything: true }, undefined), []);
    assert.deepEqual(validateSchema({ anything: true }, {}), []);
  });

  it("nested object", () => {
    const s = { type: "object", properties: { sub: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } } };
    assert.match(validateSchema({ sub: { y: 1 } }, s)[0], /sub: missing required property "x"/);
  });
});
