// version.js — numeric, part-by-part comparison of "1.2.3" style versions (a
// leading "v" is ignored). Used by the background update check and unit-tested
// in Node.
(function (root) {
  function parseVersion(v) {
    return String(v == null ? '' : v).trim().replace(/^v/i, '').split('.')
      .map((part) => { const n = parseInt(part, 10); return Number.isFinite(n) ? n : 0; });
  }
  function isNewerVersion(remote, local) {
    if (!/\d/.test(String(remote == null ? '' : remote))) return false;
    const a = parseVersion(remote), b = parseVersion(local);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }
  root.parseVersion = parseVersion;
  root.isNewerVersion = isNewerVersion;
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseVersion, isNewerVersion };
})(typeof globalThis !== 'undefined' ? globalThis : this);
