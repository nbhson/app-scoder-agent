export const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const str = (description: string) => ({ type: "string", description });
export const num = (description: string) => ({ type: "number", description });
