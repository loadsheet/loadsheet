export interface Rect<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
  Squarified treemap (Bruls, Huizing, van Wijk): rows that keep each block close to square. Items go largest first
  unless `ordered` keeps the order given, so a caller can put some items last.
*/
export function squarify<T extends { value: number }>(
  items: T[],
  x: number,
  y: number,
  w: number,
  h: number,
  ordered = false,
): Rect<T>[] {
  const out: Rect<T>[] = [];
  const list = items.filter((i) => i.value > 0);
  if (!ordered) list.sort((a, b) => b.value - a.value);
  const total = list.reduce((n, i) => n + i.value, 0);
  if (!total) return out;
  const scale = (w * h) / total;
  let rest = list.map((item) => ({ item, a: item.value * scale }));
  while (rest.length) {
    const short = Math.min(w, h);
    const worst = (r: typeof rest) => {
      const s = r.reduce((n, z) => n + z.a, 0);
      const mx = Math.max(...r.map((z) => z.a)),
        mn = Math.min(...r.map((z) => z.a));
      return Math.max((short * short * mx) / (s * s), (s * s) / (short * short * mn));
    };
    const row = [rest[0]!];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]!]) <= worst(row)) row.push(rest[i++]!);
    const s = row.reduce((n, z) => n + z.a, 0);
    if (w >= h) {
      const cw = s / h;
      let cy = y;
      for (const r of row) {
        const ch = r.a / cw;
        out.push({ item: r.item, x, y: cy, w: cw, h: ch });
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      const ch = s / w;
      let cx = x;
      for (const r of row) {
        const cw = r.a / ch;
        out.push({ item: r.item, x: cx, y, w: cw, h: ch });
        cx += cw;
      }
      y += ch;
      h -= ch;
    }
    rest = rest.slice(i);
  }
  return out;
}
