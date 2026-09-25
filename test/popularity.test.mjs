// The decay and the shipped scale: the properties the whole delta story rests on.
//
//   node test/popularity.test.mjs

import { articleID, decay, strength } from "../src/wikipedia/popularity.mjs";

let pass = 0;
let fail = 0;
function check(description, condition, extra = "") {
  if (condition) {
    pass += 1;
    console.log(`  ok    ${description}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${description}${extra ? ` — ${extra}` : ""}`);
  }
}

// A steady article converges on its own rate, wherever it started.
let fromBelow = 0;
let fromAbove = 1000;
for (let day = 0; day < 200; day += 1) {
  fromBelow = decay(fromBelow, 40);
  fromAbove = decay(fromAbove, 40);
}
check(
  "a steady rate is where the score settles",
  Math.abs(fromBelow - 40) < 0.1 && Math.abs(fromAbove - 40) < 0.1,
  `${fromBelow} / ${fromAbove}`);

// The property the delta depends on: a reading that wobbles moves the shipped level far less often. The
// scale cannot absorb a wobble exactly on a boundary — a level spans [2^n - 1, 2^(n+1) - 1) — so this
// asserts the ratio rather than perfection, with a mean of five, which is inside a level rather than on
// the boundary an article with three views sits on.
const wobble = (base, day) => base + (day % 2 === 0 ? 1 : -1);
let score = 5;
let readingMoves = 0;
let levelMoves = 0;
let previousReading = 5;
let previousLevel = strength(5);
for (let day = 0; day < 60; day += 1) {
  const reading = wobble(5, day);
  score = decay(score, reading);
  const level = strength(score);
  if (reading !== previousReading) readingMoves += 1;
  if (level !== previousLevel) levelMoves += 1;
  previousReading = reading;
  previousLevel = level;
}
check(
  "a wobbling reading barely moves the shipped level",
  readingMoves > 50 && levelMoves <= 6,
  `${levelMoves} level moves against ${readingMoves} reading moves`);

// A gap decays by the time it missed rather than by one step, so a skipped rebuild is still honest.
let stepped = 5;
for (let day = 0; day < 4; day += 1) stepped = decay(stepped, 100, 1);
check("four missed days equal four single days", Math.abs(stepped - decay(5, 100, 4)) < 1e-9);

check("a new article starts at its reading", decay(0, 7) === 7);
check("a reading of zero still decays", decay(10, 0) < 10);
let monotone = true;
for (let reading = 0; reading < 5_000; reading += 1) {
  if (strength(reading) > strength(reading + 1)) monotone = false;
}
check("the shipped level is monotone", monotone && strength(2) < strength(3), `${strength(2)}/${strength(3)}`);
check("a level spans an octave", strength(3) === 2 && strength(6) === 2 && strength(7) === 3);
check("an unread article ships the lowest level", strength(0) === 0);

// Identity: stable, spread across the space, and language-aware.
check("an id is stable", articleID("en:How I Met Your Mother") === articleID("en:How I Met Your Mother"));
check("the language is part of the id", articleID("en:Same") !== articleID("de:Same"));
// The supersede list is a `Uint32Array` of `id * 2`, so an id at or above 2^31 would wrap silently and
// supersede keys belonging to other rows.
let highest = 0;
for (let at = 0; at < 50_000; at += 1) highest = Math.max(highest, articleID(`en:Article ${at}`));
check("an id stays inside 31 bits so its key fits a u32", highest * 2 < 2 ** 32, `id ${highest}`);
const ids = new Set();
for (let at = 0; at < 20_000; at += 1) ids.add(articleID(`en:Article ${at}`));
check("ids spread rather than collide", ids.size === 20_000, `${ids.size} unique of 20,000`);

console.log(`\n${fail === 0 ? "ALL PASSED" : `${fail} FAILED`} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
