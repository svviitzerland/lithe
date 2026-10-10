import {
  box,
  defineApp,
  input,
  kv,
  list,
  progress,
  row,
  rule,
  spacer,
  spinner,
  table,
  text,
  type Child,
} from "@lithe/app";

type Tab = "overview" | "live" | "form";

interface State {
  tab: Tab;
  cursor: number;
  ticks: number;
  name: string;
  caret: number;
  greeted: string | null;
  /** fetched lazily on first visit to the live tab */
  repo: { stars: number; forks: number; issues: number } | null;
  loading: boolean;
  error: string | null;
}

const TABS: Tab[] = ["overview", "live", "form"];
const FEATURES = [
  "Zero dependencies, zero native code",
  "One file deploys to Vercel or Workers",
  "State travels with the session, not the server",
  "SSH in: no TLS, no browser, no bundle",
];

export default defineApp<State>({
  name: "lithe demo",
  description: "A terminal app running on serverless, reachable over plain SSH.",

  init: () => ({
    tab: "overview",
    cursor: 0,
    ticks: 0,
    name: "",
    caret: 0,
    greeted: null,
    repo: null,
    loading: false,
    error: null,
  }),

  async update(s, ev, io) {
    if (ev.t === "tick") s.ticks++;

    if (ev.t === "key") {
      const k = ev.key;
      if (k === "ctrl+c" || (k === "q" && s.tab !== "form")) return io.exit();

      if (k === "tab" || k === "right" || k === "l") {
        s.tab = TABS[(TABS.indexOf(s.tab) + 1) % TABS.length]!;
        s.cursor = 0;
      } else if (k === "shift+tab" || k === "left" || k === "h") {
        s.tab = TABS[(TABS.indexOf(s.tab) + TABS.length - 1) % TABS.length]!;
        s.cursor = 0;
      } else if (s.tab === "overview") {
        if (k === "up" || k === "k") s.cursor = Math.max(0, s.cursor - 1);
        if (k === "down" || k === "j") s.cursor = Math.min(FEATURES.length - 1, s.cursor + 1);
      } else if (s.tab === "form") {
        if (ev.rune) {
          s.name = s.name.slice(0, s.caret) + ev.rune + s.name.slice(s.caret);
          s.caret++;
        } else if (k === "backspace" && s.caret > 0) {
          s.name = s.name.slice(0, s.caret - 1) + s.name.slice(s.caret);
          s.caret--;
        } else if (k === "left") s.caret = Math.max(0, s.caret - 1);
        else if (k === "right") s.caret = Math.min(s.name.length, s.caret + 1);
        else if (k === "enter") s.greeted = s.name.trim() || null;
      }
    }

    // Async work lives right here in update — the function stays alive for it.
    if (s.tab === "live" && !s.repo && !s.loading && !s.error) {
      s.loading = true;
      io.wake(80); // paint the spinner before the fetch resolves
      try {
        const res = await fetch("https://api.github.com/repos/charmbracelet/bubbletea", {
          headers: { "user-agent": "lithe-demo" },
        });
        if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
        const j = (await res.json()) as {
          stargazers_count: number;
          forks_count: number;
          open_issues_count: number;
        };
        s.repo = { stars: j.stargazers_count, forks: j.forks_count, issues: j.open_issues_count };
      } catch (err) {
        s.error = err instanceof Error ? err.message : String(err);
      } finally {
        s.loading = false;
      }
    }

    io.title(`lithe · ${s.tab}`);
    io.wake(1000);
  },

  view(s, size, io) {
    const tabBar = row(
      { gap: 2 },
      TABS.map((t) =>
        text(t === s.tab ? `● ${t}` : `○ ${t}`, {
          fg: t === s.tab ? "cyan" : undefined,
          bold: t === s.tab,
          dim: t !== s.tab,
        }),
      ),
    );

    let body: Child;
    if (s.tab === "overview") {
      body = box({ gap: 1 }, [
        text("Why this exists", { bold: true }),
        text(
          "SSH cannot terminate on a serverless function — there is no inbound TCP. " +
            "lithe splits the problem: a tiny relay speaks SSH, your function speaks frames.",
          { dim: true },
        ),
        list(FEATURES, s.cursor),
      ]);
    } else if (s.tab === "live") {
      body = s.repo
        ? box({ gap: 1 }, [
            text("charmbracelet/bubbletea", { bold: true }),
            table(
              [
                ["stars", s.repo.stars.toLocaleString()],
                ["forks", s.repo.forks.toLocaleString()],
                ["open issues", s.repo.issues.toLocaleString()],
              ],
              { head: ["metric", "value"] },
            ),
            text(""),
            progress(Math.min(1, s.repo.stars / 40000), { width: 28, showPercent: true }),
            text("fetched inside update(), from the edge", { dim: true, italic: true }),
          ])
        : s.error
          ? text(`could not load: ${s.error}`, { fg: "red" })
          : row({ gap: 1 }, [spinner(s.ticks, "dots", { fg: "cyan" }), text("fetching live data…")]);
    } else {
      // `input` parks the real terminal cursor itself, so typing feels native.
      body = box({ gap: 1 }, [
        text("Your keystrokes made a round trip to a serverless function.", { dim: true }),
        input(s.name, s.caret, { label: "name:", width: 24, focused: true }),
        s.greeted ? text(`hello, ${s.greeted} 👋`, { fg: "green", bold: true }) : text(""),
        text("enter to greet · tab to leave", { dim: true }),
      ]);
    }

    return box({ pad: 1, h: "fill", gap: 1 }, [
      row([
        text("lithe", { bold: true, fg: "cyan" }),
        text(`  ${io.ctx.user}@${io.ctx.app ?? "local"}`, { dim: true }),
        spacer(),
        text(`${size.cols}×${size.rows}`, { dim: true }),
      ]),
      tabBar,
      rule(),
      box({ grow: 1 }, [body]),
      rule(),
      kv([["keys", "tab switch · ↑/↓ move · q quit"]]),
    ]);
  },
});
