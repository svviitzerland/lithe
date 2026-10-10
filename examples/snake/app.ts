import { box, defineApp, row, spacer, text, type Child } from "@lithe/app";

/**
 * Animation without a process.
 *
 * A serverless function cannot hold a `setInterval`, so the app asks to be woken
 * instead: `io.wake(ms)` makes the relay deliver a `tick` event later. The whole
 * game lives in the session blob, which is why this works at all.
 */

const W = 28;
const H = 14;

type Point = [number, number];
type Dir = "up" | "down" | "left" | "right";

interface State {
  snake: Point[];
  dir: Dir;
  food: Point;
  score: number;
  best: number;
  dead: boolean;
  paused: boolean;
  tick: number;
}

const DELTA: Record<Dir, Point> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

function placeFood(snake: Point[]): Point {
  // Deterministic enough, and never inside the snake.
  for (let i = 0; i < 200; i++) {
    const p: Point = [1 + Math.floor(Math.random() * (W - 2)), 1 + Math.floor(Math.random() * (H - 2))];
    if (!snake.some(([x, y]) => x === p[0] && y === p[1])) return p;
  }
  return [1, 1];
}

function fresh(best = 0): State {
  const snake: Point[] = [[8, 7], [7, 7], [6, 7]];
  return { snake, dir: "right", food: placeFood(snake), score: 0, best, dead: false, paused: false, tick: 0 };
}

export default defineApp<State>({
  name: "snake",
  description: "A game of snake, served over SSH from a function that does not stay running.",

  init: () => fresh(),

  update(s, ev, io) {
    if (ev.t === "key") {
      const k = ev.key;
      if (k === "q" || k === "ctrl+c") return io.exit();
      if (k === "r" && s.dead) return fresh(s.best);
      if (k === "p") s.paused = !s.paused;
      const want: Partial<Record<string, Dir>> = {
        up: "up", k: "up", down: "down", j: "down",
        left: "left", h: "left", right: "right", l: "right",
      };
      const d = want[k];
      // Refuse a reversal: it would be an instant self-collision.
      if (d && d !== OPPOSITE[s.dir]) s.dir = d;
    }

    if (ev.t === "tick" && !s.dead && !s.paused) {
      s.tick++;
      const head = s.snake[0]!;
      const [dx, dy] = DELTA[s.dir];
      const next: Point = [head[0] + dx, head[1] + dy];

      const hitWall = next[0] <= 0 || next[0] >= W - 1 || next[1] <= 0 || next[1] >= H - 1;
      const hitSelf = s.snake.some(([x, y]) => x === next[0] && y === next[1]);
      if (hitWall || hitSelf) {
        s.dead = true;
        s.best = Math.max(s.best, s.score);
        io.bell();
      } else {
        s.snake.unshift(next);
        if (next[0] === s.food[0] && next[1] === s.food[1]) {
          s.score += 10;
          s.food = placeFood(s.snake);
        } else {
          s.snake.pop();
        }
      }
    }

    io.title(`snake · ${s.score}`);
    if (!s.dead && !s.paused) io.wake(Math.max(60, 130 - s.score)); // speeds up as you score
  },

  view(s) {
    // One string per row, so the frame diff only touches lines that moved.
    const grid: string[][] = Array.from({ length: H }, (_, y) =>
      Array.from({ length: W }, (_, x) =>
        y === 0 || y === H - 1 ? "─" : x === 0 || x === W - 1 ? "│" : " ",
      ),
    );
    grid[0]![0] = "╭"; grid[0]![W - 1] = "╮";
    grid[H - 1]![0] = "╰"; grid[H - 1]![W - 1] = "╯";
    grid[s.food[1]]![s.food[0]] = "◆";
    s.snake.forEach(([x, y], i) => {
      grid[y]![x] = i === 0 ? "█" : "▓";
    });

    const board: Child[] = grid.map((r, i) =>
      text(r.join(""), { wrap: false, fg: i === 0 || i === H - 1 ? 240 : undefined }),
    );

    return box({ pad: 1, gap: 1 }, [
      row([
        text("snake", { bold: true, fg: "green" }),
        spacer(),
        text(`score ${s.score}`, { bold: true }),
        text(`  best ${s.best}`, { dim: true }),
      ]),
      box(board),
      s.dead
        ? text("dead. r to restart, q to quit", { fg: "red", bold: true })
        : s.paused
          ? text("paused. p to resume", { fg: "yellow" })
          : text("↑↓←→ or hjkl · p pause · q quit", { dim: true }),
    ]);
  },
});
