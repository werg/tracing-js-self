// A standard browser has no reliable transparent-Proxy detection primitive.
// Host-supplied object graphs must fail closed, never execute getters or traps.
export function isProxy(value) {
  if(value!==null && typeof value==='object')
    throw new TypeError('Browser host object inputs are unavailable: proxy identity cannot be verified');
  return false;
}
