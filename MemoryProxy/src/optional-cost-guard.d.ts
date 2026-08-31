/**
 * The cost-guard package is an optional internal submodule. Keep the dynamic
 * import type-safe without requiring that package to exist in public clones.
 */
declare module "@context-proxy/cost-guard" {
  export function openKernelStsCosBackend(
    options: import("./storage/cos-types.js").KernelStsCosOptions,
  ): import("./storage/cos-types.js").CosLikeBackend;
}
