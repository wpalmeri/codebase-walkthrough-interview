/**
 * openapi-typescript 7.13 supports the TypeScript 5 compiler API. The
 * application itself is already evaluating TypeScript 7, whose public package
 * intentionally no longer exposes that API. Keep code generation isolated on
 * the supported compiler without downgrading application type checking.
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "typescript" &&
    context.parentURL?.includes("/node_modules/openapi-typescript/")
  ) {
    return nextResolve("typescript-openapi-codegen", context);
  }
  return nextResolve(specifier, context);
}
