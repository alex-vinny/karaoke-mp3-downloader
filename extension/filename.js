// filename.js — the one sanitiser for the saved file name. Loaded as a plain
// script by the content scripts (global `safeFilename`), pulled into the service
// worker with importScripts(), and required by the Node unit tests.
//
// Keeps letters of any script (accents included), digits, spaces and a few safe
// punctuation marks; drops emoji, symbols, invisible characters and everything
// Windows or Chrome rejects in a file name; collapses whitespace; strips leading
// and trailing dots; cuts at a word boundary to `maxLength` characters; never
// returns an empty name. The extension (.mp3) is added by the caller.
(function (root) {
  // Control characters, format characters (zero-width space/joiner, bidi marks,
  // BOM), line/paragraph separators and emoji variation selectors: Chrome rejects
  // the file name and reports only "Invalid filename".
  const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Variation_Selector}]/gu;
  const NOT_ALLOWED = /[^\p{L}\p{N}\p{M} \-_(),.'&!]/gu;
  const TRAILING_JUNK = /[\s.\-_(,&]+$/;
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function safeFilename(title, opts) {
    const maxLength = (opts && opts.maxLength) || 60;
    let s = String(title == null ? '' : title)
      .normalize('NFC')
      .replace(INVISIBLE, '')
      .replace(NOT_ALLOWED, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '');
    if (s.length > maxLength) {
      const cut = s.slice(0, maxLength);
      const space = cut.lastIndexOf(' ');
      s = space >= Math.floor(maxLength * 0.6) ? cut.slice(0, space) : cut;
    }
    s = s.replace(TRAILING_JUNK, '');
    if (!s) return 'audio';
    if (RESERVED.test(s)) return s + ' audio';
    return s;
  }

  root.safeFilename = safeFilename;
  if (typeof module !== 'undefined' && module.exports) module.exports = { safeFilename };
})(typeof globalThis !== 'undefined' ? globalThis : this);
