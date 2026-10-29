// Small glob matcher for repo-relative paths: `**` any folders, `*` within one folder,
// `?` one character. Paths are compared with forward slashes and case-sensitively,
// except that on Windows-style input backslashes are turned into slashes first.

const cache = new Map<string, RegExp>();

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  const g = toPosix(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // "**/" matches zero or more folders; a trailing "**" matches everything below.
        if (g[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function matchesAny(path: string, globs: string[]): boolean {
  const p = toPosix(path);
  return globs.some((g) => globToRegExp(g).test(p));
}
