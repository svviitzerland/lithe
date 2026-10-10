package main

import (
	"strings"
	"unicode/utf8"
)

var csiKeys = map[string]string{
	"A": "up", "B": "down", "C": "right", "D": "left",
	"H": "home", "F": "end", "Z": "shift+tab",
	"1~": "home", "2~": "insert", "3~": "delete", "4~": "end",
	"5~": "pgup", "6~": "pgdn", "7~": "home", "8~": "end",
	"11~": "f1", "12~": "f2", "13~": "f3", "14~": "f4", "15~": "f5",
	"17~": "f6", "18~": "f7", "19~": "f8", "20~": "f9", "21~": "f10",
	"23~": "f11", "24~": "f12",
	"P": "f1", "Q": "f2", "R": "f3", "S": "f4",
}

var mods = [8]string{"", "shift+", "alt+", "alt+shift+", "ctrl+", "ctrl+shift+", "ctrl+alt+", "ctrl+alt+shift+"}

func ctrlName(r rune) (string, bool) {
	switch {
	case r == 0:
		return "ctrl+space", true
	case r == 9:
		return "tab", true
	case r == 13 || r == 10:
		return "enter", true
	case r == 27:
		return "esc", true
	case r == 127 || r == 8:
		return "backspace", true
	case r >= 1 && r <= 26:
		return "ctrl+" + string(rune('a'+r-1)), true
	}
	return "", false
}

// DecodeInput turns raw terminal bytes into canonical events. Kept in lockstep
// with packages/core/src/keys.ts so apps see one key vocabulary everywhere.
func DecodeInput(s string) []Event {
	var out []Event
	for i := 0; i < len(s); {
		if strings.HasPrefix(s[i:], "\x1b[200~") {
			end := strings.Index(s[i:], "\x1b[201~")
			if end == -1 {
				out = append(out, Event{T: "paste", Data: s[i+6:]})
				break
			}
			out = append(out, Event{T: "paste", Data: s[i+6 : i+end]})
			i += end + 6
			continue
		}

		if s[i] == 0x1b {
			if i+1 >= len(s) {
				out = append(out, Event{T: "key", Key: "esc"})
				break
			}
			next := s[i+1]
			if next == '[' || next == 'O' {
				j := i + 2
				params := ""
				for j < len(s) && (s[j] == ';' || (s[j] >= '0' && s[j] <= '9')) {
					params += string(s[j])
					j++
				}
				if j >= len(s) {
					out = append(out, Event{T: "key", Key: "esc"})
					break
				}
				final := string(s[j])
				parts := strings.Split(params, ";")
				mod := 0
				if len(parts) > 1 {
					for _, c := range parts[1] {
						mod = mod*10 + int(c-'0')
					}
					mod--
				}
				name, ok := csiKeys[final]
				if !ok {
					name, ok = csiKeys[parts[0]+final]
				}
				if !ok {
					name, ok = csiKeys[params+final]
				}
				if ok {
					prefix := ""
					if !strings.Contains(name, "+") && mod > 0 && mod < 8 {
						prefix = mods[mod&7]
					}
					out = append(out, Event{T: "key", Key: prefix + name})
				}
				i = j + 1
				continue
			}

			r, size := utf8.DecodeRuneInString(s[i+1:])
			if name, ok := ctrlName(r); ok {
				out = append(out, Event{T: "key", Key: "alt+" + name})
			} else {
				out = append(out, Event{T: "key", Key: "alt+" + string(r)})
			}
			i += 1 + size
			continue
		}

		r, size := utf8.DecodeRuneInString(s[i:])
		if name, ok := ctrlName(r); ok {
			out = append(out, Event{T: "key", Key: name})
		} else if r == ' ' {
			out = append(out, Event{T: "key", Key: "space", Rune: " "})
		} else {
			out = append(out, Event{T: "key", Key: string(r), Rune: string(r)})
		}
		i += size
	}
	return out
}
