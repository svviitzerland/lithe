/** Canonical key name, e.g. "a", "A", "ctrl+c", "shift+tab", "up", "f5", "enter". */
export interface KeyEvent {
  t: "key";
  key: string;
  /** the printable character, when there is one */
  rune?: string;
}

export interface PasteEvent {
  t: "paste";
  data: string;
}

export type InputEvent = KeyEvent | PasteEvent;

const CSI_KEYS: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left",
  H: "home", F: "end", Z: "shift+tab",
  "1~": "home", "2~": "insert", "3~": "delete", "4~": "end",
  "5~": "pgup", "6~": "pgdn", "7~": "home", "8~": "end",
  "11~": "f1", "12~": "f2", "13~": "f3", "14~": "f4", "15~": "f5",
  "17~": "f6", "18~": "f7", "19~": "f8", "20~": "f9", "21~": "f10",
  "23~": "f11", "24~": "f12",
  P: "f1", Q: "f2", R: "f3", S: "f4",
};

const MODS = ["", "shift+", "alt+", "alt+shift+", "ctrl+", "ctrl+shift+", "ctrl+alt+", "ctrl+alt+shift+"];

function ctrlName(code: number): string | undefined {
  if (code === 0) return "ctrl+space";
  if (code === 9) return "tab";
  if (code === 13 || code === 10) return "enter";
  if (code === 27) return "esc";
  if (code === 127 || code === 8) return "backspace";
  if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(96 + code)}`;
  return undefined;
}

/**
 * Decode a chunk of terminal input into events. This is the reference
 * implementation; the Go relay carries an equivalent decoder so apps only ever
 * see canonical key names.
 */
export function decodeInput(s: string): InputEvent[] {
  const out: InputEvent[] = [];
  let i = 0;

  while (i < s.length) {
    const c = s[i]!;

    // Bracketed paste: ESC[200~ ... ESC[201~
    if (s.startsWith("\x1b[200~", i)) {
      const end = s.indexOf("\x1b[201~", i);
      const data = end === -1 ? s.slice(i + 6) : s.slice(i + 6, end);
      out.push({ t: "paste", data });
      i = end === -1 ? s.length : end + 6;
      continue;
    }

    if (c === "\x1b") {
      const next = s[i + 1];

      if (next === "[" || next === "O") {
        // CSI / SS3: ESC [ params final
        let j = i + 2;
        let params = "";
        while (j < s.length && /[0-9;]/.test(s[j]!)) params += s[j++]!;
        const final = s[j];
        if (final === undefined) {
          out.push({ t: "key", key: "esc" });
          i = s.length;
          continue;
        }
        const parts = params.split(";");
        const mod = parts.length > 1 ? Number(parts[1]) - 1 : 0;
        const name = CSI_KEYS[final] ?? CSI_KEYS[`${parts[0]}${final}`] ?? CSI_KEYS[`${params}${final}`];
        if (name) {
          const prefix = name.includes("+") ? "" : (MODS[mod & 7] ?? "");
          out.push({ t: "key", key: prefix + name });
        }
        i = j + 1;
        continue;
      }

      if (next !== undefined) {
        // alt+<char> arrives as ESC <char>
        const ctrl = ctrlName(next.charCodeAt(0));
        out.push({ t: "key", key: `alt+${ctrl ?? next}` });
        i += 2;
        continue;
      }

      out.push({ t: "key", key: "esc" });
      i += 1;
      continue;
    }

    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const ctrl = ctrlName(cp);
    if (ctrl) out.push({ t: "key", key: ctrl });
    else if (cp === 32) out.push({ t: "key", key: "space", rune: " " });
    else out.push({ t: "key", key: ch, rune: ch });
    i += ch.length;
  }

  return out;
}
