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
        space >= you.length ? 1 : 0,
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
