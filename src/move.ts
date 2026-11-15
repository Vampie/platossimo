export type Coord = { x: number; y: number };
export type Snake = { id: string; health: number; length: number; head: Coord; body: Coord[] };
export type GameState = {
  board: { width: number; height: number; food: Coord[]; snakes: Snake[] };
  you: Snake;
};
export type Move = "up" | "down" | "left" | "right";

const DIRS: [Move, number, number][] = [
  ["up", 0, 1],
  ["down", 0, -1],
  ["left", -1, 0],
  ["right", 1, 0],
];

export function chooseMove({ board, you }: GameState): Move {
  const { width, height } = board;
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  const key = (x: number, y: number) => y * width + x;
  const others = board.snakes.filter((s) => s.id !== you.id);
  // One opponent left (a Duel, or the end of a Standard game): play for territory and attack.
  const duel = others.length === 1;

  // Cells still occupied next turn. Tails move away, except a stacked tail (just ate):
  // slice(0, -1) keeps that one because the segment before it sits on the same cell.
  const blocked = new Set<number>();
  for (const s of board.snakes) for (const c of s.body.slice(0, -1)) blocked.add(key(c.x, c.y));

  // Next to an opponent's head: risky if it is as long as us (head-on kills us), prey if shorter (we win).
  const risky = new Set<number>();
  const prey = new Set<number>();
  for (const s of others) {
    for (const [, dx, dy] of DIRS) {
      const x = s.head.x + dx, y = s.head.y + dy;
      if (inBounds(x, y)) (s.length < you.length ? prey : risky).add(key(x, y));
    }
  }

  // BFS over free cells: steps from (x, y) to every cell, Infinity if unreachable.
  const distances = (x: number, y: number, blockedSet: Set<number> = blocked) => {
    const dist = new Array<number>(width * height).fill(Infinity);
    dist[key(x, y)] = 0;
    const queue = [[x, y]];
    for (let i = 0; i < queue.length; i++) {
      const [cx, cy] = queue[i];
      for (const [, dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
        if (inBounds(nx, ny) && !blockedSet.has(k) && dist[k] === Infinity) {
          dist[k] = dist[key(cx, cy)] + 1;
          queue.push([nx, ny]);
        }
      }
    }
    return dist;
  };

  // Ticks from now until the body segment sitting in each cell has moved on (0 = free
  // already). We know our own future precisely, so every one of our segments gets its
  // real vacate tick - a stacked tail (just ate) naturally takes the later of its two
  // ticks by keeping the max. An opponent's path is someone else's choice, so only
  // their tail (same as the plain blocked-cell model) counts as free; the rest of
  // their body stays blocked for the whole search, same as before this change.
  const NEVER = width * height + 1; // past any tick this search can reach
  // Same vacate-tick rule as before, but usable for either side: ownerId's own body
  // ages for real, everyone else only ever frees up their own tail.
  const vacateAtFor = (ownerId: string) => {
    const v = new Uint16Array(width * height);
    for (const s of board.snakes) {
      const n = s.body.length;
      const owner = s.id === ownerId;
      for (let i = 0; i < n; i++) {
        const k = key(s.body[i].x, s.body[i].y);
        const ticks = owner || i === n - 1 ? n - i : NEVER;
        if (ticks > v[k]) v[k] = ticks;
      }
    }
    return v;
  };
  const vacateAt = vacateAtFor(you.id);

  // How soon the opponent could plausibly occupy each cell, expanding every tick from
  // their current head in every direction - not a guessed path, just a bound on what
  // they could reach by a given tick. Capped at our own length: safeSpace never needs
  // to know about anything further out than that. Duel only (one opponent to bound).
  const opponentTick = (opponent: Snake) => {
    const oppVacate = vacateAtFor(opponent.id);
    const tick = new Int16Array(width * height).fill(-1);
    const startK = key(opponent.head.x, opponent.head.y);
    tick[startK] = 0;
    const queue = [startK];
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i], t = tick[k];
      if (t >= you.length) continue;
      const cx = k % width, cy = (k / width) | 0;
      for (const [, dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy, nk = key(nx, ny);
        if (inBounds(nx, ny) && tick[nk] === -1 && t + 1 >= oppVacate[nk]) {
          tick[nk] = t + 1;
          queue.push(nk);
        }
      }
    }
    return tick;
  };
  const oppTick = duel ? opponentTick(others[0]) : null;

  const CORRIDOR_MARGIN = 2; // shortcut: a flat constant, not tuned - widen if a thin corridor still gets through

  // Room from (x, y), but a cell only counts once its vacate tick has passed - so
  // trailing your own retreating tail around a loop counts as room, while a dead end
  // that merely ends at your tail's current spot does not, since nothing past it ever
  // opens up. A cell the opponent could reach at or before our own arrival tick doesn't
  // count either - their body may still be sweeping through it when we'd need it. And a
  // single-file path with no branch point needs a margin above the bare minimum, since
  // one wrong assumption anywhere along it leaves no room to react.
  const safeSpace = (x: number, y: number) => {
    const seen = new Set([key(x, y)]);
    const queue: [number, number, number][] = [[x, y, 1]]; // this move lands here at tick 1
    let count = 0, sawBranch = false;
    for (let i = 0; i < queue.length; i++) {
      const [cx, cy, tick] = queue[i];
      count++;
      let branches = 0;
      for (const [, dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
        if (!inBounds(nx, ny) || seen.has(k) || tick + 1 < vacateAt[k]) continue;
        // Contested: the opponent could be there first, or at the same tick without us
        // being strictly longer - a tie only goes to us if we'd win the head-on.
        if (duel && oppTick && oppTick[k] !== -1) {
          const theirs = oppTick[k], arrive = tick + 1;
          if (theirs < arrive || (theirs === arrive && others[0].length >= you.length)) continue;
        }
        branches++;
        seen.add(k);
        queue.push([nx, ny, tick + 1]);
      }
      if (branches >= 2) sawBranch = true;
      if (count >= you.length + CORRIDOR_MARGIN || (sawBranch && count >= you.length)) break;
    }
    return count >= you.length && (sawBranch || count >= you.length + CORRIDOR_MARGIN);
  };

  const longestOther = Math.max(0, ...others.map((s) => s.length));
  // In a duel keep a 2-length lead, so one meal for the opponent does not cost us head-on wins.
  const hungry = you.health < 40 || you.length < longestOther + (duel ? 2 : 1);

  // One step of a snake, ignoring growth from food: good enough to look 2 moves ahead.
  const moveTo = (s: Snake, dx: number, dy: number): Snake => {
    const head = { x: s.head.x + dx, y: s.head.y + dy };
    return { ...s, head, body: [head, ...s.body.slice(0, -1)] };
  };

  // Territory after both snakes have moved once: how many cells each reaches first.
  const territoryAfter = (meAfter: Snake, oppAfter: Snake) => {
    const blocked2 = new Set<number>();
    for (const c of meAfter.body.slice(0, -1)) blocked2.add(key(c.x, c.y));
    for (const c of oppAfter.body.slice(0, -1)) blocked2.add(key(c.x, c.y));
    const mineDist = distances(meAfter.head.x, meAfter.head.y, blocked2);
    const theirDist = distances(oppAfter.head.x, oppAfter.head.y, blocked2);
    let t = 0;
    for (let c = 0; c < mineDist.length; c++) {
      if (mineDist[c] < theirDist[c]) t++;
      else if (mineDist[c] > theirDist[c]) t--;
    }
    return t;
  };

  // 2 ply: our move, then the opponent's most likely reply, scored by territory.
  // Not a worst-case (minimax) reply: real opponents don't play to spite us, they grab
  // their own space, so we predict the move that gives THEM the most room.
  const lookaheadTerritory = (dx: number, dy: number) => {
    const opponent = others[0];
    const meAfter = moveTo(you, dx, dy);
    const oppMoves = DIRS
      .map(([, odx, ody]) => [odx, ody] as [number, number])
      .filter(([odx, ody]) => {
        const x = opponent.head.x + odx, y = opponent.head.y + ody;
        return inBounds(x, y) && !blocked.has(key(x, y));
      });
    if (!oppMoves.length) return Infinity; // the opponent has no safe move left
    const predicted = oppMoves.reduce((best, m) => {
      const space = distances(opponent.head.x + m[0], opponent.head.y + m[1]).filter((d) => d < Infinity).length;
      return space > best.space ? { move: m, space } : best;
    }, { move: oppMoves[0], space: -1 }).move;
    return territoryAfter(meAfter, moveTo(opponent, predicted[0], predicted[1]));
  };

  // Each option gets a score tuple, compared left to right: higher wins.
  const options: { move: Move; score: number[] }[] = [];
  for (const [move, dx, dy] of DIRS) {
    const x = you.head.x + dx, y = you.head.y + dy, k = key(x, y);
    if (!inBounds(x, y) || blocked.has(k)) continue;
    const mine = distances(x, y);
    const space = mine.filter((d) => d < Infinity).length;
    const foodDist = Math.min(...board.food.map((f) => Math.abs(f.x - x) + Math.abs(f.y - y)));
    options.push({
      move,
      score: [
        safeSpace(x, y) ? 1 : 0,
        risky.has(k) ? 0 : 1,
        duel && prey.has(k) ? 1 : 0,
        hungry ? -foodDist : 0,
        duel ? lookaheadTerritory(dx, dy) : space,
      ],
    });
  }
  if (!options.length) return "up"; // every move is fatal, so any answer will do

  options.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i];
    return 0;
  });
  return options[0].move;
}
