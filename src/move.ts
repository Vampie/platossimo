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
  const distances = (x: number, y: number) => {
    const dist = new Array<number>(width * height).fill(Infinity);
    dist[key(x, y)] = 0;
    const queue = [[x, y]];
    for (let i = 0; i < queue.length; i++) {
      const [cx, cy] = queue[i];
      for (const [, dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
        if (inBounds(nx, ny) && !blocked.has(k) && dist[k] === Infinity) {
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
  const theirDist = duel ? distances(others[0].head.x, others[0].head.y) : [];

  // Each option gets a score tuple, compared left to right: higher wins.
  const options: { move: Move; score: number[] }[] = [];
  for (const [move, dx, dy] of DIRS) {
    const x = you.head.x + dx, y = you.head.y + dy, k = key(x, y);
    if (!inBounds(x, y) || blocked.has(k)) continue;
    const mine = distances(x, y);
    const space = mine.filter((d) => d < Infinity).length;
    // Voronoi territory: +1 per cell we reach first, -1 per cell the opponent reaches first.
    // We arrive at mine[c] + 1 because this move is spent getting to (x, y).
    let territory = 0;
    for (let c = 0; duel && c < mine.length; c++) {
      if (mine[c] + 1 < theirDist[c]) territory++;
      else if (mine[c] + 1 > theirDist[c]) territory--;
    }
    const foodDist = Math.min(...board.food.map((f) => Math.abs(f.x - x) + Math.abs(f.y - y)));
    options.push({
      move,
      score: [
        space >= you.length ? 1 : 0,
        risky.has(k) ? 0 : 1,
        duel && prey.has(k) ? 1 : 0,
        hungry ? -foodDist : 0,
        duel ? territory : space,
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
