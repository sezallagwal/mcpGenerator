export function toPascalCase(s: string): string {
  const result = s
    .replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toUpperCase());
  return /^\d/.test(result) ? `_${result}` : result;
}
