import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseMove, type GameState, type Snake } from "../src/move.ts";

const snake = (id: string, body: [number, number][], health = 100): Snake => ({
  id,
  health,
  length: body.length,
  head: { x: body[0][0], y: body[0][1] },
  body: body.map(([x, y]) => ({ x, y })),
});

const game = (you: Snake, others: Snake[] = [], food: [number, number][] = []): GameState => ({
  board: { width: 11, height: 11, food: food.map(([x, y]) => ({ x, y })), snakes: [you, ...others] },
  you,
});

test("stays inside the walls and off its own neck", () => {
  assert.equal(chooseMove(game(snake("me", [[0, 0], [1, 0], [2, 0]]))), "up");
});

test("does not run into another snake", () => {
  const me = snake("me", [[5, 5], [4, 5], [3, 5]]);
  const wall = snake("other", [[6, 4], [6, 5], [6, 6], [7, 6]]);
  const move = chooseMove(game(me, [wall]));
  assert.notEqual(move, "right");
  assert.notEqual(move, "left");
});

test("may move into a tail that moves away", () => {
  assert.equal(chooseMove(game(snake("me", [[0, 0], [0, 1], [1, 1], [1, 0]]))), "right");
});

test("does not chase food into a dead end", () => {
  const me = snake("me", [[1, 1], [1, 2], [0, 2], [0, 3], [0, 4]], 10);
  const blocker = snake("other", [[2, 0], [3, 0], [4, 0]]);
  assert.equal(chooseMove(game(me, [blocker], [[0, 0]])), "right");
});

test("avoids a head-on collision with a longer snake", () => {
  const me = snake("me", [[5, 5], [5, 4], [5, 3]]);
  const bigger = snake("other", [[5, 7], [5, 8], [5, 9], [5, 10]]);
  assert.notEqual(chooseMove(game(me, [bigger])), "up");
});

test("goes for food when hungry", () => {
  const me = snake("me", [[5, 5], [5, 4], [5, 3]], 10);
  assert.equal(chooseMove(game(me, [], [[8, 5]])), "right");
});

test("duel: moves to claim more territory than the opponent", () => {
  const me = snake("me", [[2, 5], [1, 5], [0, 5], [0, 4], [0, 3]]);
  const opponent = snake("other", [[8, 5], [9, 5], [10, 5]]);
  assert.equal(chooseMove(game(me, [opponent])), "right");
});

test("duel: goes head-on at a shorter opponent", () => {
  const me = snake("me", [[5, 5], [5, 4], [5, 3], [5, 2], [5, 1]]);
  const shorter = snake("other", [[7, 5], [8, 5], [9, 5]]);
  assert.equal(chooseMove(game(me, [shorter])), "right");
});

test("duel: keeps eating until 2 longer than the opponent", () => {
  const me = snake("me", [[5, 5], [5, 4], [5, 3], [5, 2]]);
  const opponent = snake("other", [[0, 10], [1, 10], [2, 10]]);
  assert.equal(chooseMove(game(me, [opponent], [[8, 5]])), "right");
});
