declare module "js-yaml" {
  /** OpenAPI 契约解析只需 load；返回值按 unknown 处理并逐层收窄。 */
  export function load(input: string): unknown;
  export function dump(input: unknown): string;
}
