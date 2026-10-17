/** Whether the Vault path pattern of a policy rule matches `path`: `+` and a template are one segment, a trailing `*` any rest. */
export function reaches(pattern, path) {
  const source = pattern.replace(/\{\{[^}]*\}\}/g, '\0').replace(/[.?^$|()[\]\\]/g, '\\$&')
    .replace(/\0|\+/g, '[^/]+').replace(/\*$/, '.*');
  return new RegExp(`^${source}$`).test(path);
}
