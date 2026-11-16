// main.ts — driver for the markdown-render-speed-02 competition.
//
// The grader runs `node /bot/main.ts` on Node 22+ (types are stripped,
// so only erasable syntax is used). It reads every case from
// /input/cases.json, renders each one with parse() from parse.js, and
// writes the HTML strings in case order as a JSON array to
// /output/html.json. Outside the grading container the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables stand in for
// /input and /output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

function run() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const rawText = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const parsed = JSON.parse(rawText);
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  const html = new Array(cases.length);
  for (let idx = 0; idx < cases.length; idx++) {
    html[idx] = parse(cases[idx].markdown);
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

run();
