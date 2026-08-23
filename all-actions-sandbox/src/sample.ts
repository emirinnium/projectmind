/** Sample module for exhaustive smoke. @since 0.1 */
export interface User { id: number; email: string }
const CACHE = new Map<number, User>();
export async function fetchUser(id: number): Promise<User> {
  const hit = CACHE.get(id);
  if (hit) return hit;
  const res = await fetch("/api/user/" + id);
  const u = (await res.json()) as User;
  CACHE.set(id, u);
  return u;
}
export function clearCache(): void { CACHE.clear(); }
