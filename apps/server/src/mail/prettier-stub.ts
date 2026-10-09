/**
 * Stands in for `prettier/standalone` and `prettier/plugins/html` in the production bundle
 * (tsdown `alias`). `@react-email/render` imports prettier statically for its `pretty` option,
 * which rooster never uses; bundling it would add about 2 MB. Calling it is a bug.
 */
export function format(): never {
  throw new Error('prettier is not bundled: render emails without `pretty`');
}
